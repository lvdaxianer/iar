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
import { DEFAULT_RECENT_MESSAGE_LIMIT, MAX_CONVERSATION_TURN_TEXT_LENGTH, MAX_RECENT_MESSAGE_CHARS, MAX_RECENT_MESSAGE_LIMIT, SCHEMA_VERSIONS, type ActionDefinition, type ActionResult, type ClarificationState, type CollectionState, type ConversationTurn, type EventName, type JsonValue, type PendingInput, type PendingReference, type WorkflowDefinition } from '@iar/contracts';
import { ModelGateway, ModelProfileRegistry, type IarRuntimeConfiguration, type SelfIntroductionOptions } from '@iar/runtime';
import { PersistenceSubscriptionBridge } from '@iar/storage';
import type { SessionMessage, SessionPersistenceProvider } from '@iar/storage';
import { PluginHost } from '@iar/plugins';
import { BehaviorContextProjector, type AsyncDecisionAdapter, type AsyncFunctionCallAdapter, type AsyncNestedRouteAdapter } from '@iar/runtime';
import { SubscriptionDispatcher, SubscriptionRegistry, type DispatchEvent } from '@iar/subscriptions';
import { InMemoryEventStore, type SnapshotStore } from '@iar/storage';
import { LocalWorkflow, WorkflowEventLog, type ActionExecutor } from '@iar/runtime';
import { SyncPluginBridge } from './execution/sync-plugin-bridge.js';
import { BrainModelProvider } from './models/llm-provider.js';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import type { PiAgentDelegate } from './models/pi-agent-delegate.js';
import { createSandboxModels, createSandboxRuntime } from './session-dependencies.js';
import { summarizeAction } from './session-helpers.js';
import { writeSafeLog } from './safe-log.js';
import type { ConfirmResult, SandboxDecisionBackend, SandboxMode, SandboxState, TurnResult } from './session-types.js';

/** 会话内所有事件共享的 runId，保证压缩校验的单运行边界。 */
export const SESSION_RUN_ID = 'sandbox-session';

/** 会话内所有事件共享的 correlationId。 */
export const SESSION_CORRELATION_ID = 'sandbox-session';

/** 路由未命中且兜底回复生成失败时的固定话术。 */
export const FALLBACK_REPLY_TEXT = '我暂时无法确定你的需求。请补充想查询的对象、希望了解的结果，或明确说明是否要执行某个新操作；如果是在追问当前会话的结果，也可以说明想查看哪项信息。';

/** 发送到持久化订阅桥的最小状态事件输入。 */
type PersistenceEventInput = {
  /** 受控事件名称。 */
  eventName: EventName;
  /** 事件所属的工作流运行。 */
  runId: string;
  /** 可重放 JSON 载荷。 */
  payload: JsonValue;
  /** 消息事件的可选消息标识。 */
  messageId?: string;
  /** 重试幂等使用的事件标识。 */
  eventId?: string;
  /** 事实发生时间。 */
  occurredAt?: string;
};

/** 兼容旧 SnapshotStore 与新 Persistence Provider 的共同快照形状。 */
type RestorableSnapshot = {
  eventId: string;
  revision: number;
  context: import('@iar/contracts').BehaviorContext;
};

/** sandbox 会话构造参数，集中约束 Agent 级运行时配置。 */
type SandboxSessionOptions = {
  mode: SandboxMode;
  decisionBackend?: SandboxDecisionBackend;
  sessionId?: string;
  snapshotStore?: SnapshotStore;
  persistenceProvider?: SessionPersistenceProvider;
  persistenceProviderOpened?: boolean;
  recentMessageLimit?: number;
  piAgent?: PiAgentDelegate;
  disabledPluginIds?: readonly string[];
  systemPrompt?: string;
  selfIntroduction?: SelfIntroductionOptions;
};

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
  /** 可替换的持久化 Provider；未注入时保持旧的快照兼容模式。 */
  protected readonly persistenceProvider: SessionPersistenceProvider | undefined;
  /** Provider 订阅桥的有界异步调度器。 */
  private readonly persistenceDispatcher: SubscriptionDispatcher | undefined;
  /** 恢复完成前禁止处理该会话的新请求。 */
  private readonly restoration: Promise<void>;
  /** 已排入快照的单调版本。 */
  protected snapshotRevision = 0;
  /** 本会话选择的模型模式；重置不改变依赖配置。 */
  protected readonly mode: SandboxMode;
  /** 会话私有插件宿主，执行时只访问已启用候选。 */
  protected readonly pluginHost: PluginHost;
  /** 创建 Agent 时固化的插件开关和自我介绍提示词。 */
  protected readonly configuration: IarRuntimeConfiguration;
  /** 回复使用的 provider；scripted 模式不访问上游。 */
  protected readonly brainProvider: BrainModelProvider | ScriptedModelProvider;
  /** 可选的进程内 Pi 兜底委托；未注入时未命中路由走 IAR 兜底回复。 */
  protected readonly piAgent: PiAgentDelegate | undefined;
  /** 根据角色获取模型策略及超时配置。 */
  protected readonly registry: ModelProfileRegistry;
  /** 将模型请求分派到配置的 provider。 */
  protected readonly gateway: ModelGateway;
  /** Function 与 Plugin 路由分别使用对应决策角色。 */
  protected readonly functionDecisionAdapter: AsyncDecisionAdapter;
  protected readonly pluginDecisionAdapter: AsyncDecisionAdapter;
  protected readonly functionCallAdapter: AsyncFunctionCallAdapter;
  /** 主路径一次性 nested Plugin/Function proposal。 */
  protected readonly nestedRouteAdapter: AsyncNestedRouteAdapter;
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
  /** 最近消息窗口的会话级数量上限。 */
  protected readonly recentMessageLimit: number;
  /** 最近消息进入模型前的单条字符上限。 */
  protected readonly recentMessageMaxChars = MAX_RECENT_MESSAGE_CHARS;
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
   * @param options - sandbox 模式及 Agent 级 Plugin 配置
   * @throws Error 当插件安装失败、模型配置非法或任一知识库加载失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public constructor(options: SandboxSessionOptions) {
    try {
      this.mode = options.mode; this.sessionId = options.sessionId ?? SESSION_RUN_ID;
      this.piAgent = options.piAgent;
      this.recentMessageLimit = normalizeRecentMessageLimit(options.recentMessageLimit);
      this.snapshotStore = options.snapshotStore; this.persistenceProvider = options.persistenceProvider;
      const { dispatcher, models, runtime } = this.createSessionDependencies(options);
      this.persistenceDispatcher = dispatcher;
      this.pluginHost = runtime.pluginHost;
      this.configuration = runtime.configuration;
      this.brainProvider = models.brain; this.registry = models.registry; this.gateway = models.gateway;
      this.functionDecisionAdapter = models.functionAdapter; this.pluginDecisionAdapter = models.pluginAdapter; this.functionCallAdapter = models.functionCallAdapter; this.nestedRouteAdapter = models.nestedRouteAdapter;
      this.workflow = this.createWorkflow();
      this.restoration = this.initializePersistence(options.persistenceProviderOpened === true);
    } catch (error) {
      // 任一依赖失败时必须释放已启动的执行线程。
      this.bridge.dispose();
      throw error;
    }
  }

  /**
   * 创建会话所需的持久化桥、模型依赖和插件运行时。
   *
   * @param options - sandbox 会话构造参数
   * @returns 会话初始化依赖
   * @author lvdaxianer@yeah.net
   * @date 2026-10-21
   */
  private createSessionDependencies(options: SandboxSessionOptions): {
    dispatcher: SubscriptionDispatcher | undefined;
    models: ReturnType<typeof createSandboxModels>;
    runtime: ReturnType<typeof createSandboxRuntime>;
  } {
    const dispatcher = this.createPersistenceDispatcher(options.persistenceProvider);
    const models = createSandboxModels(options);
    const runtime = createSandboxRuntime(models.functionAdapter, options);
    return { dispatcher, models, runtime };
  }

  /** 等待持久化上下文恢复完成，避免新问题读取到半初始化状态。 */
  public whenReady(): Promise<void> { return this.restoration; }

  /**
   * 等待当前会话的 Hook 事件和 Provider 写入全部排空。
   * @returns 所有已接受的持久化写入均完成
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  public async flushPersistence(): Promise<void> {
    await this.whenReady();
    await this.persistenceDispatcher?.drain();
    await this.persistenceProvider?.flush();
  }


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
    this.piAgent?.reset();
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

  /** 将响应模型的有限澄清状态写成事件并立即投影，再异步保存快照。 */
  protected async updateClarification(pending: PendingInput): Promise<void> {
    this.workflowEventLog.clarificationUpdated(SESSION_RUN_ID, pending);
    await this.drainWorkflowEvents();
  }

  /** 在完整助手回复提交后记录一条有序会话轮次。
   * @param userText - 本轮用户输入
   * @param result - 已完成的公开会话结果
   * @returns 轮次事件已经投影到当前上下文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-24
   */
  protected async completeConversationTurn(userText: string, result: TurnResult | ConfirmResult): Promise<void> {
    const normalizedUserText = userText.trim();
    if (normalizedUserText.length === 0) return;
    const assistantText = finalAssistantText(result);
    if (assistantText === undefined) return;
    const sequence = nextConversationSequence(this.projector.current().conversationTurns?.turns);
    const turn: ConversationTurn = { turnId: `turn-${String(sequence)}`, sequence, userText: normalizedUserText.slice(0, MAX_CONVERSATION_TURN_TEXT_LENGTH), assistantText: assistantText.slice(0, MAX_CONVERSATION_TURN_TEXT_LENGTH), outcome: conversationOutcome(result), actionTaken: result.status === 'executed', completedAt: new Date().toISOString() };
    this.workflowEventLog.conversationTurnCompleted(SESSION_RUN_ID, turn);
    await this.drainWorkflowEvents();
  }

  /** 保存当前已解析事实的透明焦点，不改变执行授权或待确认状态。 */
  protected async focusFactRecord(recordId: string): Promise<void> {
    if (this.projector.current().factHistory?.focusRecordId === recordId) return;
    this.workflowEventLog.factFocused(SESSION_RUN_ID, recordId);
    await this.drainWorkflowEvents();
  }

  /** 保存连续澄清状态与当前 pending，供重启后继续安全恢复。 */
  protected async updateClarificationState(clarification: ClarificationState, pending: PendingInput = this.projector.current().pending, pendingReference: PendingReference | null | undefined = undefined, collection: CollectionState | null | undefined = undefined): Promise<void> {
    const eventLog = this.workflowEventLog as unknown as { clarificationUpdated: (runId: string, input: PendingInput, state: ClarificationState, reference: PendingReference | null | undefined, collection: CollectionState | null | undefined) => void };
    eventLog.clarificationUpdated(SESSION_RUN_ID, pending, clarification, pendingReference, collection);
    await this.drainWorkflowEvents();
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
      this.enqueuePersistenceEvent({ eventName: event.eventName, runId: event.runId, payload: event.payload, eventId: event.eventId, occurredAt: event.occurredAt });
      this.queueSnapshot(event.eventId);
    }
  }

  /**
   * 初始化 Provider 并恢复会话快照。
   * @returns Provider 初始化和快照恢复完成
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private async initializePersistence(persistenceProviderOpened: boolean): Promise<void> {
    if (!persistenceProviderOpened) await this.persistenceProvider?.open(undefined);
    await this.restoreSnapshot();
  }

  /**
   * 从兼容快照或 Provider 快照恢复当前投影。
   * @returns 恢复成功或安全降级为空上下文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private async restoreSnapshot(): Promise<void> {
    if (!this.snapshotStore && !this.persistenceProvider) return;
    const snapshot = await this.loadSnapshotSafely();
    const restored = snapshot === undefined ? false : this.restoreStructuredSnapshot(snapshot);
    await this.restoreRecentMessages();
    if (restored && snapshot) this.enqueuePersistenceEvent({ eventName: 'session.restored', runId: SESSION_RUN_ID, payload: { revision: snapshot.revision, eventId: snapshot.eventId } as JsonValue, eventId: `session-restored-${snapshot.eventId}` });
  }

  /** 读取 Provider 或兼容快照，失败时只返回空恢复结果。 */
  private async loadSnapshotSafely(): Promise<RestorableSnapshot | undefined> {
    try {
      const providerSnapshot = await this.persistenceProvider?.loadSnapshot(this.sessionId);
      return providerSnapshot ?? (await this.snapshotStore?.get(this.sessionId));
    } catch {
      writeSafeLog({ level: 'warn', event: 'sandbox.snapshot', outcome: 'snapshot_failed' });
      return undefined;
    }
  }

  /** 恢复经过契约校验的结构化快照，原始消息不参与可信状态投影。 */
  private restoreStructuredSnapshot(snapshot: RestorableSnapshot): boolean {
    try {
      this.projector = new BehaviorContextProjector(snapshot.context);
      this.snapshotRevision = snapshot.revision;
      return true;
    } catch {
      writeSafeLog({ level: 'warn', event: 'sandbox.snapshot', outcome: 'snapshot_invalid' });
      return false;
    }
  }

  /** 从 Provider 读取有界消息窗口，读取失败时安全降级为空窗口。 */
  private async restoreRecentMessages(): Promise<void> {
    if (!this.persistenceProvider) return;
    try {
      const messages = await this.persistenceProvider.listMessages(this.sessionId, { limit: this.recentMessageLimit });
      this.recentMessages = messages.flatMap((message) => toRecentMessage(message, this.recentMessageMaxChars)).slice(-this.recentMessageLimit);
    } catch {
      this.recentMessages = [];
      writeSafeLog({ level: 'warn', event: 'sandbox.recent_messages', outcome: 'restore_failed' });
    }
  }

  /** 将不可变完整上下文异步排入 SQLite，不阻塞当前会话动作。 */
  private queueSnapshot(eventId: string): void {
    if (!this.snapshotStore && !this.persistenceProvider) return;
    const revision = ++this.snapshotRevision;
    const context = this.projector.current();
    const legacySnapshot = { runId: this.sessionId, eventId, revision, context };
    const providerSnapshot = { sessionId: this.sessionId, runId: SESSION_RUN_ID, eventId, revision, context };
    void this.snapshotStore?.save(legacySnapshot).catch(() => {
      // 持久化故障不阻塞当前请求，但必须以固定枚举留下可观测信号。
      writeSafeLog({ level: 'warn', event: 'sandbox.snapshot', outcome: 'snapshot_failed' });
    });
    this.enqueuePersistenceEvent({ eventName: 'context.updated', runId: SESSION_RUN_ID, payload: { snapshot: providerSnapshot } as unknown as JsonValue, eventId: `context-updated-${eventId}` });
  }

  /** 在压缩事件投影后异步保存包含摘要的当前结构化上下文。 */
  protected queueSnapshotAfterCompaction(eventId: string): void {
    this.queueSnapshot(eventId);
  }

  /**
   * 将会话消息发布为受控异步事件，Provider 不参与消息 ID 生成。
   * @param message - 已生成并校验的会话消息
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  protected recordMessage(message: SessionMessage): void {
    const eventName = message.role === 'user' ? 'message.received' : 'message.sent';
    this.enqueuePersistenceEvent({ eventName, runId: SESSION_RUN_ID, payload: { message } as unknown as JsonValue, messageId: message.messageId, eventId: `message-${message.messageId}` });
  }

  /**
   * 允许压缩组件发布已追加的事实事件而不依赖订阅实现。
   * @param event - 已写入本地事实源的事件
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  protected publishPersistenceEvent(event: { eventName: EventName; eventId: string; runId: string; occurredAt: string; payload: JsonValue }): void {
    this.enqueuePersistenceEvent(event);
  }

  /**
   * 创建 Provider 专属的异步 Hook 调度器。
   * @param provider - 可替换的持久化 Provider
   * @returns 已安装桥接订阅的调度器或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private createPersistenceDispatcher(provider: SessionPersistenceProvider | undefined): SubscriptionDispatcher | undefined {
    if (!provider) return undefined;
    const registry = new SubscriptionRegistry();
    const dispatcher = new SubscriptionDispatcher(registry);
    new PersistenceSubscriptionBridge(provider).install(registry, dispatcher);
    return dispatcher;
  }

  /**
   * 把状态事件送入有界队列；持久化故障不阻断会话主流程。
   * @param input - 受控持久化事件
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private enqueuePersistenceEvent(input: PersistenceEventInput): void {
    const dispatcher = this.persistenceDispatcher;
    if (!dispatcher) return;
    const event: DispatchEvent = {
      eventId: input.eventId ?? `sandbox-hook-${randomUUID()}`,
      eventName: input.eventName,
      runId: input.runId,
      sessionId: this.sessionId,
      correlationId: SESSION_CORRELATION_ID,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      payload: input.payload
    };
    dispatcher.enqueue(event);
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
    const functionRecord = resolved.ok ? resolved.value.functions.get(action.functionId) : undefined;
    if (!resolved.ok || !functionRecord || typeof functionRecord.handler !== 'function') {
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: 'plugin.unavailable' };
    }
    try {
      const pluginId = resolved.value.manifest.pluginId;
      const result = this.bridge.run(pluginId, action.input, { pluginId, functionId: action.functionId, runId: action.runId, correlationId: SESSION_CORRELATION_ID });
      if (result.status === 'succeeded') return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'succeeded', output: result.output, response: result.response };
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: result.errorCode ?? 'plugin.failed', response: result.response };
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

/** 校验会话级最近消息数量，避免模型窗口配置失控。 */
function normalizeRecentMessageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RECENT_MESSAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECENT_MESSAGE_LIMIT) throw new Error('recentMessageLimit 超出允许范围');
  return limit;
}

/** 将 Provider 消息转换为不具备执行权限的模型窗口条目。 */
function toRecentMessage(message: SessionMessage, maxMessageChars: number): { role: string; text: string }[] {
  if (!['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string') return [];
  return [{ role: message.role, text: message.content.slice(0, maxMessageChars) }];
}

/** 只接受已经提交的非空最终回复，过滤流式超限的说明结果。 */
function finalAssistantText(result: TurnResult | ConfirmResult): string | undefined {
  if (!('reply' in result) || ('reasonCode' in result && result.reasonCode === 'model_response_too_large')) return undefined;
  const reply = result.reply.trim();
  return reply.length === 0 ? undefined : reply;
}

/** 将公开结果映射为不具备授权含义的轮次结果。 */
function conversationOutcome(result: TurnResult | ConfirmResult): ConversationTurn['outcome'] {
  if (result.status === 'awaiting_confirmation') return 'awaiting_confirmation';
  if (result.status === 'clarification') return 'needs_clarification';
  if (result.status === 'failed') return 'failed';
  if (result.status === 'cancelled') return 'cancelled';
  return 'completed';
}

/** 从当前有序历史计算下一个轮次序号。 */
function nextConversationSequence(turns: ConversationTurn[] | undefined): number {
  return (turns?.at(-1)?.sequence ?? 0) + 1;
}
