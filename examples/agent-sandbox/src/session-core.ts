/** 会话资源、状态快照和工作流事件宿主。
 * 该基类是所有编排层共享可变状态和资源的唯一所有者。
 * 上层只复用受保护接口，不新建第二套事件或工作流状态。
 * 会话管理器负责串行调用、空闲回收和释放。
 * reset 只替换状态，不替换已初始化的插件和模型依赖。
 * 工作流事件通过 drain 顺序投影，避免状态快照落后于已完成动作。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionResult, type WorkflowDefinition } from '@iar/contracts';
import { ModelGateway, ModelProfileRegistry } from '@iar/decision';
import { PluginHost } from '@iar/plugin-host';
import { BehaviorContextProjector, type AsyncDecisionAdapter } from '@iar/runtime';
import { InMemoryEventStore, type SnapshotStore } from '../../../packages/storage/src/index.js';
import { LocalWorkflow, WorkflowEventLog, type ActionExecutor } from '@iar/workflow';
import { SyncPluginBridge } from './execution/sync-plugin-bridge.js';
import { BrainModelProvider } from './models/llm-provider.js';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import { createSandboxModels, createSandboxPluginHost } from './session-dependencies.js';
import { summarizeAction } from './session-helpers.js';
import { writeSafeLog } from './safe-log.js';
import type { SandboxDecisionBackend, SandboxMode, SandboxState } from './session-types.js';

/** 会话内所有事件共享的 runId，保证压缩校验的单运行边界。 */
export const SESSION_RUN_ID = 'sandbox-session';

/** 会话内所有事件共享的 correlationId。 */
export const SESSION_CORRELATION_ID = 'sandbox-session';

/** 路由未命中且兜底回复生成失败时的固定话术。 */
export const FALLBACK_REPLY_TEXT = '我没有完全理解你的意图。可以试试：平台知识问答（「如何申请数据权限」）、数据集成（「列出今天的集成任务」）、任务监控（「订单汇总 Job 跑完了吗」）、资产检索（「搜一下用户表」）、系统告警（「现在有哪些告警」）、创建工单（「帮我提个工单，网络很卡」）或转人工。';

/** sandbox 单轮执行状态机定义。 */
export const TURN_DEFINITION: WorkflowDefinition = {
  schemaVersion: SCHEMA_VERSIONS.workflow,
  workflowId: 'sandbox-turn-v1',
  version: '1.0.0',
  description: 'agent sandbox 单轮执行状态机',
  states: ['start', 'awaiting_confirmation', 'executing', 'done'],
  initialState: 'start',
  terminalStates: ['done'],
  transitions: [
    { event: 'begin', from: 'start', to: 'executing' },
    { event: 'request_confirmation', from: 'start', to: 'awaiting_confirmation' },
    { event: 'complete', from: 'executing', to: 'done' },
    { event: 'complete', from: 'awaiting_confirmation', to: 'done' }
  ]
};

/** 会话资源、状态快照和工作流事件宿主。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionCore {
  /** 服务端稳定会话标识，作为 SQLite 快照的隔离键。 */
  protected readonly sessionId: string;
  /** 共享的异步快照存储，由服务生命周期统一关闭。 */
  protected readonly snapshotStore: SnapshotStore | undefined;
  /** 恢复完成前禁止处理该会话的新请求。 */
  private readonly restoration: Promise<void>;
  /** 已排入快照的单调版本。 */
  protected snapshotRevision = 0;
  /** 本会话选择的模型模式；重置不改变依赖配置。 */
  protected readonly mode: SandboxMode;
  /** 会话私有插件宿主，执行时只访问已启用候选。 */
  protected readonly pluginHost: PluginHost;
  /** 回复使用的 provider；scripted 模式不访问上游。 */
  protected readonly brainProvider: BrainModelProvider | ScriptedModelProvider;
  /** 根据角色获取模型策略及超时配置。 */
  protected readonly registry: ModelProfileRegistry;
  /** 将模型请求分派到配置的 provider。 */
  protected readonly gateway: ModelGateway;
  /** Function 与 Plugin 路由分别使用对应决策角色。 */
  protected readonly functionDecisionAdapter: AsyncDecisionAdapter;
  protected readonly pluginDecisionAdapter: AsyncDecisionAdapter;
  /** 线程属于该会话，构造失败、过期或服务关闭时释放。 */
  protected readonly bridge = new SyncPluginBridge();
  /** 工作流日志与投影按当前会话隔离，重置时一起替换。 */
  protected workflowEventLog = createSessionEventLog();
  /** 工作流实例复用本会话日志，但每一轮执行重新创建。 */
  protected workflow: LocalWorkflow;
  /** 投影只处理该会话事件，供 state 与压缩读取。 */
  protected projector = new BehaviorContextProjector();
  /** 事件存储不跨会话共享，资源上限由会话管理器控制。 */
  protected eventStore = new InMemoryEventStore();
  /** 最近对话用于回复生成，写入时限制保留数量。 */
  protected recentMessages: Array<{ role: string; text: string }> = [];
  /** 待确认动作只存在于本会话，不能被另一个会话确认。 */
  protected pending: { action: ActionDefinition } | null = null;
  /** 自重置以来的轮次、压缩及决策事件序号。 */
  protected turnCount = 0;
  /** 压缩序号用于生成本会话内唯一的压缩事件标识。 */
  protected compactCount = 0;
  /** 决策序号独立于工作流事件序号。 */
  protected decisionEventCount = 0;
  /** 已投影的工作流事件数，避免后续 drain 重复追加。 */
  protected consumedWorkflowEvents = 0;

  /**
   * 安装并启用十个子系统插件，预加载全部本地知识库，构建 gateway 和首个 Workflow 实例。
   *
   * @param options - sandbox 模式（brain/scripted）
   * @throws Error 当插件安装失败、模型配置非法或任一知识库加载失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public constructor(options: { mode: SandboxMode; decisionBackend?: SandboxDecisionBackend; sessionId?: string; snapshotStore?: SnapshotStore }) {
    try {
      this.mode = options.mode;
      this.sessionId = options.sessionId ?? SESSION_RUN_ID;
      this.snapshotStore = options.snapshotStore;
      this.pluginHost = createSandboxPluginHost();
      const models = createSandboxModels(options);
      this.brainProvider = models.brain;
      this.registry = models.registry;
      this.gateway = models.gateway;
      this.functionDecisionAdapter = models.functionAdapter;
      this.pluginDecisionAdapter = models.pluginAdapter;
      this.workflow = this.createWorkflow();
      this.restoration = this.restoreSnapshot();
    } catch (error) {
      // 任一依赖失败时必须释放已启动的执行线程。
      this.bridge.dispose();
      throw error;
    }
  }

  /** 等待持久化上下文恢复完成，避免新问题读取到半初始化状态。 */
  public whenReady(): Promise<void> { return this.restoration; }


  /**
   * 返回调试面板使用的会话状态快照。
   *
   * @returns 当前上下文、全部事件和统计信息
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async state(): Promise<SandboxState> {
    const events = await this.eventStore.list();
    return {
      mode: this.mode,
      context: this.projector.current(),
      events,
      stats: { turnCount: this.turnCount, eventCount: events.length, compactCount: this.compactCount, pendingConfirmation: this.pending !== null },
      pending: this.pending ? summarizeAction(this.pending.action) : null
    };
  }


  /**
   * 清空事件、投影、Workflow 和消息历史，重建全部会话状态。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async reset(): Promise<void> {
    this.projector = new BehaviorContextProjector();
    this.eventStore = new InMemoryEventStore();
    this.workflowEventLog = createSessionEventLog();
    this.workflow = this.createWorkflow();
    this.recentMessages = [];
    this.pending = null;
    this.turnCount = 0;
    this.compactCount = 0;
    this.decisionEventCount = 0;
    this.consumedWorkflowEvents = 0;
    this.queueSnapshot('reset');
  }


  /**
   * 释放插件执行桥等外部资源。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public dispose(): void {
    this.bridge.dispose();
  }


  /**
   * 创建绑定共享 EventLog 的新 Workflow 实例。
   *
   * @returns 本地 Workflow 实例
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected createWorkflow(): LocalWorkflow {
    return new LocalWorkflow({ eventLog: this.workflowEventLog });
  }


  /**
   * 取消上一个回合遗留的待确认动作。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected async cancelStalePending(): Promise<void> {
    if (!this.pending) return;
    this.workflow.cancel(this.pending.action.runId);
    await this.drainWorkflowEvents();
    this.pending = null;
  }


  /**
   * 把 Workflow EventLog 中尚未消费的事件追加到 EventStore 并投影。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected async drainWorkflowEvents(): Promise<void> {
    const all = this.workflowEventLog.events;
    for (const event of all.slice(this.consumedWorkflowEvents)) {
      await this.eventStore.append(event);
      this.projector.apply(event);
      this.consumedWorkflowEvents += 1;
      this.queueSnapshot(event.eventId);
    }
  }

  /** 从最新有效快照恢复当前投影；无效快照只降级为空上下文。 */
  private async restoreSnapshot(): Promise<void> {
    if (!this.snapshotStore) return;
    try {
      const snapshot = await this.snapshotStore.get(this.sessionId);
      if (!snapshot) return;
      this.projector = new BehaviorContextProjector(snapshot.context);
      this.snapshotRevision = snapshot.revision;
    } catch {
      // 持久化损坏不能阻止会话建立，更不能把不可信内容交给模型。
      writeSafeLog({ level: 'warn', event: 'sandbox.snapshot', outcome: 'snapshot_failed' });
    }
  }

  /** 将不可变完整上下文异步排入 SQLite，不阻塞当前会话动作。 */
  private queueSnapshot(eventId: string): void {
    if (!this.snapshotStore) return;
    const snapshot = { runId: this.sessionId, eventId, revision: ++this.snapshotRevision, context: this.projector.current() };
    void this.snapshotStore.save(snapshot).catch(() => {
      // 持久化故障不阻塞当前请求，但必须以固定枚举留下可观测信号。
      writeSafeLog({ level: 'warn', event: 'sandbox.snapshot', outcome: 'snapshot_failed' });
    });
  }


  /**
   * 构造把插件 Handler 包成 ActionResult 的同步 executor。
   *
   * @returns 可交给 Workflow 的 ActionExecutor
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected createExecutor(): ActionExecutor {
    return (action) => this.executePluginAction(action);
  }

  /** 通过隔离线程执行已解析插件并映射稳定结果。
   * @param action - 待执行动作
   * @returns 插件动作结果，不暴露执行桥异常
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private executePluginAction(action: ActionDefinition): ActionResult {
    const resolved = this.pluginHost.resolveCandidate(action.functionId, action.pluginId);
    if (!resolved.ok || typeof resolved.value.handler !== 'function') {
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: 'plugin.unavailable' };
    }
    try {
      const pluginId = resolved.value.manifest.pluginId;
      const result = this.bridge.run(pluginId, action.input, { pluginId, functionId: action.functionId, runId: action.runId, correlationId: SESSION_CORRELATION_ID });
      if (result.status === 'succeeded') return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'succeeded', output: result.output };
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: result.errorCode ?? 'plugin.failed' };
    } catch {
      // 执行桥失败统一转为稳定错误，不泄漏原始异常。
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: 'plugin.executor_failed' };
    }
  }
}

/** 为每次会话实例生成不会跨进程复用的事件来源前缀。 */
function createSessionEventLog(): WorkflowEventLog {
  return new WorkflowEventLog({ correlationId: SESSION_CORRELATION_ID, eventIdPrefix: `workflow-event-${randomUUID()}` });
}
