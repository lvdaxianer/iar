/**
 * 提供 IAR agent sandbox 的会话组合根。
 *
 * 每个会话组合 PluginHost、ModelGateway、TwoStageRouter、LocalWorkflow、
 * BehaviorContextProjector 和 InMemoryEventStore，实现单轮对话的完整链路：
 * 语义抽取 → 两阶段路由 → 策略/确认 → 插件执行 → 回复生成 → 事件投影。
 * 由于 LocalWorkflow 的 ActionExecutor 是同步签名，插件 Handler 通过
 * SyncPluginBridge 在 worker 线程中执行。
 * 路由未命中时优先生成兜底回复（brain 走 Response Generator，scripted 走模板），
 * brain 模式语义抽取失败时用离线 ScriptedModelProvider 重试一次；
 * turnStreamed 提供 SSE 流式输出，response.generate 阶段逐段透传 delta。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SCHEMA_VERSIONS,
  type ActionDefinition,
  type ActionResult,
  type BehaviorContext,
  type CompactionResult,
  type EventEnvelope,
  type JsonValue,
  type SlotValue,
  type WorkflowDefinition
} from '@iar/contracts';
import {
  ContextCompactorAdapter,
  DecisionBackendResolver,
  IntentModelDecisionAdapter,
  JevDecisionAdapter,
  ModelGateway,
  ModelProfileRegistry,
  ResponseGeneratorAdapter,
  SemanticExtractorAdapter,
  UnifiedDecisionAdapter,
  loadModelProfiles,
  type DecisionBackend,
  type DecisionRequest,
  type ModelGatewayResult,
  type ModelProvider,
  type SemanticFrame
} from '@iar/decision';
import { PluginHost } from '@iar/plugin-host';
import type { PluginHandlerResult } from '@iar/plugin-sdk';
import {
  BehaviorContextProjector,
  ContextCompactionService,
  TwoStageRouter,
  type AsyncDecisionAdapter,
  type CompactionRequest,
  type RouteResult
} from '@iar/runtime';
import type { RuleEvaluationFacts } from '@iar/rule-engine';
// @iar/storage 的 exports 未声明 types 条件，示例按测试约定直接引用编译后的相对源码路径。
import { InMemoryEventStore } from '../../../packages/storage/src/index.js';
import {
  LocalWorkflow,
  WorkflowEventLog,
  confirmationScopeHash,
  type ActionExecutor
} from '@iar/workflow';
import { humanTransferPlugin } from '../../human-transfer/src/index.js';
import { knowledgeQueryPlugin } from '../../knowledge-query/src/index.js';
import { ticketCreatePlugin } from '../../ticket-create/src/index.js';
import { SyncPluginBridge } from './execution/sync-plugin-bridge.js';
import { BrainModelProvider, IntentModelProvider, OpenAICompatibleModelProvider } from './models/llm-provider.js';
import { ScriptedModelProvider } from './models/scripted-provider.js';
import { sandboxFunctionRules, sandboxPluginRules } from './rules.js';

/** sandbox 模式：brain 使用真实 LLM，scripted 使用离线假大脑。 */
export type SandboxMode = 'brain' | 'scripted';

/** sandbox 可选的决策 backend；默认保留 JEV 优先解析。 */
export type SandboxDecisionBackend = DecisionBackend;

/** 路由证据摘要，供调试面板展示。 */
export type RouteEvidence = {
  /** 路由终态。 */
  status: string;
  /** 稳定原因码。 */
  reasonCode: string;
  /** 语义意图。 */
  semanticIntent: string;
  /** 语义置信度。 */
  semanticConfidence: number;
  /** Function 选择。 */
  functionId?: string;
  /** Plugin 选择。 */
  pluginId?: string;
  /** Function 决策分数。 */
  functionScore?: number;
  /** Plugin 决策分数。 */
  pluginScore?: number;
  /** 语义抽取是否走了离线 ScriptedModelProvider 兜底重试。 */
  semanticFallback?: boolean;
};

/** 待确认动作摘要，供前端渲染确认按钮。 */
export type PendingActionSummary = {
  /** Action 标识。 */
  actionId: string;
  /** 运行标识。 */
  runId: string;
  /** 目标 Function。 */
  functionId: string;
  /** 目标 Plugin。 */
  pluginId: string;
  /** 风险等级。 */
  riskLevel: string;
  /** 是否需要确认。 */
  confirmationRequired: boolean;
  /** Action 输入。 */
  input: JsonValue;
};

/** 单轮对话结果联合。 */
export type TurnResult =
  | { status: 'executed'; reply: string; route: RouteEvidence; actionResult: ActionResult }
  | { status: 'awaiting_confirmation'; reply: string; route: RouteEvidence; pending: PendingActionSummary }
  | { status: 'clarification'; reply: string; route: RouteEvidence; reasonCode: string }
  | { status: 'failed'; reply: string; route: RouteEvidence; reasonCode: string };

/** 流式输出的阶段标识。 */
export type TurnStage = 'semantic' | 'route' | 'action' | 'response';

/** turnStreamed 下发的事件联合。 */
export type StreamEvent =
  | { type: 'stage'; stage: TurnStage }
  | { type: 'delta'; text: string }
  | { type: 'done'; result: TurnResult }
  | { type: 'error'; reasonCode: string; message: string };

/** 语义抽取阶段的内部结果联合。 */
type ExtractFrameOutcome =
  | { ok: true; frame: SemanticFrame; semanticFallback: boolean }
  | { ok: false; route: RouteEvidence; reasonCode: string; reply: string };

/** 单轮执行阶段的内部结果联合。 */
type ExecuteTurnOutcome =
  | { status: 'executed'; action: ActionDefinition; actionResult: ActionResult }
  | { status: 'awaiting_confirmation'; action: ActionDefinition; reply: string }
  | { status: 'clarification'; reply: string; reasonCode: string }
  | { status: 'failed'; reply: string; reasonCode: string };

/** 确认操作结果联合。 */
export type ConfirmResult =
  | { status: 'executed'; reply: string; actionResult: ActionResult }
  | { status: 'cancelled'; reply: string }
  | { status: 'failed'; reply: string; reasonCode: string };

/** 上下文压缩结果。 */
export type CompactResult = {
  /** 压缩是否成功。 */
  ok: boolean;
  /** 稳定原因码。 */
  reasonCode?: string;
  /** 失败摘要或模型错误消息。 */
  error?: string;
  /** 压缩摘要。 */
  summary?: string;
  /** 压缩前关键字段哈希。 */
  hashBefore: string;
  /** 压缩后关键字段哈希。 */
  hashAfter: string;
  /** 写入的事件标识。 */
  eventId?: string;
};

/** 调试面板轮询的会话状态。 */
export type SandboxState = {
  /** 当前模式。 */
  mode: SandboxMode;
  /** 当前 BehaviorContext 投影。 */
  context: BehaviorContext;
  /** 全部事件。 */
  events: EventEnvelope[];
  /** 运行统计。 */
  stats: { turnCount: number; eventCount: number; compactCount: number; pendingConfirmation: boolean };
  /** 当前待确认动作。 */
  pending: PendingActionSummary | null;
};

/** 会话内所有事件共享的 runId，保证压缩校验的单运行边界。 */
const SESSION_RUN_ID = 'sandbox-session';

/** 会话内所有事件共享的 correlationId。 */
const SESSION_CORRELATION_ID = 'sandbox-session';

/** 路由未命中且兜底回复生成失败时的固定话术。 */
const FALLBACK_REPLY_TEXT = '我没有完全理解你的意图。可以试试：查询知识（如“查一下退款政策”）、创建工单（如“帮我提个工单，网络很卡”）或转接人工。';

/** sandbox 单轮执行状态机定义。 */
const TURN_DEFINITION: WorkflowDefinition = {
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

/**
 * IAR agent sandbox 会话，聚合运行时全链路的宿主组合根。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class IarSandboxSession {
  private readonly mode: SandboxMode;
  private readonly pluginHost: PluginHost;
  private readonly brainProvider: BrainModelProvider | ScriptedModelProvider;
  private readonly registry: ModelProfileRegistry;
  private readonly gateway: ModelGateway;
  private readonly functionDecisionAdapter: AsyncDecisionAdapter;
  private readonly pluginDecisionAdapter: AsyncDecisionAdapter;
  private readonly bridge = new SyncPluginBridge();
  private workflowEventLog = new WorkflowEventLog({ correlationId: SESSION_CORRELATION_ID });
  private workflow: LocalWorkflow;
  private projector = new BehaviorContextProjector();
  private eventStore = new InMemoryEventStore();
  private recentMessages: Array<{ role: string; text: string }> = [];
  private pending: { action: ActionDefinition } | null = null;
  private turnCount = 0;
  private compactCount = 0;
  private decisionEventCount = 0;
  private consumedWorkflowEvents = 0;

  /**
   * 安装并启用三个示例插件，构建 gateway 和首个 Workflow 实例。
   *
   * @param options - sandbox 模式（brain/scripted）
   * @throws Error 当插件安装失败或模型配置非法
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: { mode: SandboxMode; decisionBackend?: SandboxDecisionBackend }) {
    this.mode = options.mode;
    this.pluginHost = new PluginHost({ functionIds: ['knowledge.query', 'ticket.create', 'human.transfer'] });
    for (const registration of [knowledgeQueryPlugin, ticketCreatePlugin, humanTransferPlugin]) {
      if (!this.pluginHost.install(registration).ok) throw new Error(`插件安装失败: ${registration.manifest.pluginId}`);
      if (!this.pluginHost.enable(registration.manifest.pluginId).ok) throw new Error(`插件启用失败: ${registration.manifest.pluginId}`);
    }
    // scripted provider 负责普通交互；决策 profile 则绑定确定性 JSON provider，避免把 response/v1 当成 DecisionResult。
    const scripted = new ScriptedModelProvider();
    const brain = options.mode === 'brain' ? new BrainModelProvider() : scripted;
    const scriptedDecision = createDecisionModelProvider();
    const intent = options.mode === 'brain' ? new IntentModelProvider() : scriptedDecision;
    const configText = readFileSync(join(process.cwd(), 'examples', 'agent-sandbox', 'config', 'models.brain.json'), 'utf8');
    const configuredBackend = options.decisionBackend ?? readSandboxDecisionBackend();
    const profiles = loadModelProfiles(configText).filter((profile) => profile.role !== 'function.select' && profile.role !== 'plugin.select' || configuredBackend === undefined || (profile.decisionBackend ?? 'jev') === configuredBackend);
    this.brainProvider = brain;
    this.registry = new ModelProfileRegistry(profiles);
    this.gateway = new ModelGateway({ registry: this.registry, providers: { brain, mock: scriptedDecision, 'intent-model': intent } });
    const resolver = new DecisionBackendResolver(this.registry);
    this.functionDecisionAdapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(this.gateway, 'function.select'), new IntentModelDecisionAdapter(this.gateway, 'function.select'));
    this.pluginDecisionAdapter = new UnifiedDecisionAdapter(resolver, new JevDecisionAdapter(this.gateway, 'plugin.select'), new IntentModelDecisionAdapter(this.gateway, 'plugin.select'));
    this.workflow = this.createWorkflow();
  }

  /**
   * 执行一轮对话：抽取 → 路由 → 策略/确认 → 执行 → 回复生成。
   *
   * @param text - 用户输入文本
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async turn(text: string): Promise<TurnResult> {
    const userText = text.trim();
    await this.cancelStalePending();
    this.turnCount += 1;
    const runId = SESSION_RUN_ID;
    const traceId = `trace-sandbox-${String(this.turnCount)}`;
    const extracted = await this.extractFrame(traceId, runId, userText);
    if (!extracted.ok) {
      this.pushMessages(userText, extracted.reply);
      return { status: 'failed', reply: extracted.reply, route: extracted.route, reasonCode: extracted.reasonCode };
    }
    const frame = extracted.frame;
    const route = await this.routeFrame(traceId, runId, frame);
    const evidence = buildEvidence(route, frame);
    if (extracted.semanticFallback) evidence.semanticFallback = true;
    if (route.status !== 'matched' || !route.functionId || !route.pluginId) {
      const reply = await this.fallbackReply(traceId, runId, userText, route.reasonCode);
      this.pushMessages(userText, reply);
      return { status: 'clarification', reply, route: evidence, reasonCode: route.reasonCode };
    }
    const outcome = await this.prepareAndExecute(runId, userText, frame, route);
    if (outcome.status === 'awaiting_confirmation') {
      this.pushMessages(userText, outcome.reply);
      return { status: 'awaiting_confirmation', reply: outcome.reply, route: evidence, pending: summarizeAction(outcome.action) };
    }
    if (outcome.status === 'failed') {
      this.pushMessages(userText, outcome.reply);
      return { status: 'failed', reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode };
    }
    if (outcome.status === 'clarification') {
      this.pushMessages(userText, outcome.reply);
      return { status: 'clarification', reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode };
    }
    const reply = await this.generateReply(traceId, runId, userText, outcome.action, outcome.actionResult);
    this.pushMessages(userText, reply);
    return { status: 'executed', reply, route: evidence, actionResult: outcome.actionResult };
  }

  /**
   * 执行一轮流式对话，逐阶段下发事件，response.generate 阶段透传 delta。
   *
   * 语义抽取、路由和执行复用 turn() 的私有步骤；scripted 模式没有真实流，
   * 回复阶段一次性下发 delta 与 done。done 事件的 result 与 turn() 返回同构。
   *
   * @param text - 用户输入文本
   * @param emit - 流式事件回调
   * @returns 本轮对话结果（与 done 事件内容一致）
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async turnStreamed(text: string, emit: (event: StreamEvent) => void): Promise<TurnResult> {
    const userText = text.trim();
    emit({ type: 'stage', stage: 'semantic' });
    await this.cancelStalePending();
    this.turnCount += 1;
    const runId = SESSION_RUN_ID;
    const traceId = `trace-sandbox-${String(this.turnCount)}`;
    const finish = (result: TurnResult): TurnResult => {
      emit({ type: 'done', result });
      return result;
    };
    const extracted = await this.extractFrame(traceId, runId, userText);
    if (!extracted.ok) {
      this.pushMessages(userText, extracted.reply);
      return finish({ status: 'failed', reply: extracted.reply, route: extracted.route, reasonCode: extracted.reasonCode });
    }
    emit({ type: 'stage', stage: 'route' });
    const frame = extracted.frame;
    const route = await this.routeFrame(traceId, runId, frame);
    const evidence = buildEvidence(route, frame);
    if (extracted.semanticFallback) evidence.semanticFallback = true;
    if (route.status !== 'matched' || !route.functionId || !route.pluginId) {
      const reply = await this.fallbackReplyStreamed(traceId, runId, userText, route.reasonCode, (delta) => emit({ type: 'delta', text: delta }));
      this.pushMessages(userText, reply);
      return finish({ status: 'clarification', reply, route: evidence, reasonCode: route.reasonCode });
    }
    emit({ type: 'stage', stage: 'action' });
    const outcome = await this.prepareAndExecute(runId, userText, frame, route);
    if (outcome.status === 'awaiting_confirmation') {
      this.pushMessages(userText, outcome.reply);
      return finish({ status: 'awaiting_confirmation', reply: outcome.reply, route: evidence, pending: summarizeAction(outcome.action) });
    }
    if (outcome.status === 'failed') {
      this.pushMessages(userText, outcome.reply);
      return finish({ status: 'failed', reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode });
    }
    if (outcome.status === 'clarification') {
      this.pushMessages(userText, outcome.reply);
      return finish({ status: 'clarification', reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode });
    }
    emit({ type: 'stage', stage: 'response' });
    const reply = await this.generateReplyStreamed(traceId, runId, userText, outcome.action, outcome.actionResult, (delta) => emit({ type: 'delta', text: delta }));
    this.pushMessages(userText, reply);
    return finish({ status: 'executed', reply, route: evidence, actionResult: outcome.actionResult });
  }

  /**
   * 确认或取消当前待确认动作。
   *
   * @param accepted - 是否接受执行
   * @returns 确认后的执行结果或取消说明
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async confirm(accepted: boolean): Promise<ConfirmResult> {
    if (!this.pending) return { status: 'failed', reply: '当前没有待确认的操作。', reasonCode: 'no_pending_confirmation' };
    const { action } = this.pending;
    const runId = action.runId;
    if (!accepted) {
      this.workflow.cancel(runId);
      await this.drainWorkflowEvents();
      this.pending = null;
      const reply = '已取消该操作，未产生任何副作用。';
      this.pushAssistantMessage(reply);
      return { status: 'cancelled', reply };
    }
    const confirmed = this.workflow.confirm({ runId, action, scopeHash: confirmationScopeHash(action), confirmedAt: new Date().toISOString() });
    if (!confirmed.ok) {
      return { status: 'failed', reply: `确认失败：${confirmed.reasonCode}`, reasonCode: confirmed.reasonCode };
    }
    const resolved = this.pluginHost.resolveCandidate(action.functionId, action.pluginId);
    const capabilities = resolved.ok ? [...resolved.value.manifest.capabilities] : [];
    const executed = await this.workflow.execute({
      runId,
      action,
      requiredCapabilities: capabilities,
      grantedCapabilities: capabilities,
      authorized: true,
      executor: this.createExecutor()
    });
    await this.drainWorkflowEvents();
    if (!executed.ok) {
      this.pending = null;
      return { status: 'failed', reply: `确认后执行失败：${executed.reasonCode}`, reasonCode: executed.reasonCode };
    }
    this.pending = null;
    this.workflow.transition({ runId, event: 'complete' });
    await this.drainWorkflowEvents();
    const actionResult = executed.value;
    const reply = await this.generateReply(`trace-sandbox-confirm-${String(this.turnCount)}`, runId, '（确认执行）', action, actionResult);
    this.pushAssistantMessage(reply);
    return { status: 'executed', reply, actionResult };
  }

  /**
   * 触发一次上下文压缩：模型摘要 → 运行时校验 → 事件追加与投影。
   *
   * @returns 压缩结果，含压缩前后关键字段哈希
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async compact(): Promise<CompactResult> {
    const events = await this.eventStore.list();
    const current = this.projector.current();
    const hashBefore = current.integrity.criticalFieldHash;
    if (events.length < 2) {
      return { ok: false, reasonCode: 'insufficient_events', error: '事件不足两条，无法压缩。', hashBefore, hashAfter: hashBefore };
    }
    this.compactCount += 1;
    const compactSeq = this.compactCount;
    const occurredAt = new Date().toISOString();
    const compacted = await new ContextCompactorAdapter(this.gateway).compact({
      traceId: `trace-compact-${String(compactSeq)}`,
      runId: SESSION_RUN_ID,
      input: { behaviorContext: current, eventsToCompact: events.slice(0, -1), recentMessages: this.recentMessages }
    });
    if (!compacted.ok) {
      // 模型调用失败时也记录失败事件，保留旧视图。
      const failureEvent = this.buildCompactionFailureEvent(compactSeq, occurredAt, compacted.error.code, compacted.error.message, hashBefore);
      await this.eventStore.append(failureEvent);
      this.projector.apply(failureEvent);
      return { ok: false, reasonCode: compacted.error.code, error: compacted.error.message, hashBefore, hashAfter: this.projector.current().integrity.criticalFieldHash, eventId: failureEvent.eventId };
    }
    const outcome = new ContextCompactionService().compact(this.buildCompactionRequest(compactSeq, occurredAt, events, current, compacted.value));
    if (outcome.ok) {
      await this.eventStore.append(outcome.event);
      this.projector.apply(outcome.event);
      return { ok: true, summary: compacted.value.summary, hashBefore, hashAfter: outcome.context.integrity.criticalFieldHash, eventId: outcome.event.eventId };
    }
    await this.eventStore.append(outcome.failureEvent);
    this.projector.apply(outcome.failureEvent);
    return { ok: false, reasonCode: outcome.error.code, error: outcome.error.message, hashBefore, hashAfter: this.projector.current().integrity.criticalFieldHash, eventId: outcome.failureEvent.eventId };
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
    this.workflowEventLog = new WorkflowEventLog({ correlationId: SESSION_CORRELATION_ID });
    this.workflow = this.createWorkflow();
    this.recentMessages = [];
    this.pending = null;
    this.turnCount = 0;
    this.compactCount = 0;
    this.decisionEventCount = 0;
    this.consumedWorkflowEvents = 0;
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
  private createWorkflow(): LocalWorkflow {
    return new LocalWorkflow({ eventLog: this.workflowEventLog });
  }

  /**
   * 取消上一个回合遗留的待确认动作。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async cancelStalePending(): Promise<void> {
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
  private async drainWorkflowEvents(): Promise<void> {
    const all = this.workflowEventLog.events;
    for (const event of all.slice(this.consumedWorkflowEvents)) {
      await this.eventStore.append(event);
      this.projector.apply(event);
      this.consumedWorkflowEvents += 1;
    }
  }

  /**
   * 构造把插件 Handler 包成 ActionResult 的同步 executor。
   *
   * @returns 可交给 Workflow 的 ActionExecutor
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private createExecutor(): ActionExecutor {
    return (action: ActionDefinition): ActionResult => {
      const resolved = this.pluginHost.resolveCandidate(action.functionId, action.pluginId);
      if (!resolved.ok || typeof resolved.value.handler !== 'function') {
        return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: 'plugin.unavailable' };
      }
      let handlerResult: PluginHandlerResult;
      try {
        handlerResult = this.bridge.run(resolved.value.manifest.pluginId, action.input, {
          pluginId: resolved.value.manifest.pluginId,
          functionId: action.functionId,
          runId: action.runId,
          correlationId: SESSION_CORRELATION_ID
        });
      } catch {
        // 执行桥失败（超时/worker 异常）统一转成稳定失败码，不泄漏原始异常。
        return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: 'plugin.executor_failed' };
      }
      if (handlerResult.status === 'succeeded') {
        return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'succeeded', output: handlerResult.output };
      }
      return { schemaVersion: SCHEMA_VERSIONS.action, actionId: action.actionId, status: 'failed', errorCode: handlerResult.errorCode ?? 'plugin.failed' };
    };
  }

  /**
   * 执行语义抽取，brain 模式失败时用离线 ScriptedModelProvider 重试一次。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @returns 语义帧（含是否走了离线兜底）或稳定失败摘要
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async extractFrame(traceId: string, runId: string, userText: string): Promise<ExtractFrameOutcome> {
    const extracted = await new SemanticExtractorAdapter(this.gateway).extract({ traceId, runId, input: { text: userText } });
    if (extracted.ok) return { ok: true, frame: extracted.value, semanticFallback: false };
    if (this.mode === 'brain') {
      // 真实 LLM 抽取失败时降级到离线关键词抽取，保证链路可以继续。
      const retried = await this.retrySemanticWithScripted(traceId, runId, userText);
      if (retried.ok) return { ok: true, frame: retried.value, semanticFallback: true };
    }
    const route: RouteEvidence = { status: 'semantic_failed', reasonCode: extracted.error.code, semanticIntent: 'unknown', semanticConfidence: 0 };
    return { ok: false, route, reasonCode: extracted.error.code, reply: `语义抽取失败（${extracted.error.code}），请换个说法重试。` };
  }

  /**
   * 用离线 ScriptedModelProvider 作为 brain provider 重试语义抽取。
   *
   * 复用同一 profile registry 和 gateway 校验/超时/重试边界，
   * 只把 provider 换成离线实现，不放宽输出 Schema。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @returns 离线抽取的结构化结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async retrySemanticWithScripted(traceId: string, runId: string, userText: string): Promise<ModelGatewayResult<SemanticFrame>> {
    const fallbackGateway = new ModelGateway({ registry: this.registry, providers: { brain: new ScriptedModelProvider() } });
    return new SemanticExtractorAdapter(fallbackGateway).extract({ traceId, runId, input: { text: userText } });
  }

  /**
   * 用语义帧执行两阶段路由。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param frame - 结构化语义帧
   * @returns 两阶段路由结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private routeFrame(traceId: string, runId: string, frame: SemanticFrame): Promise<RouteResult> {
    return new TwoStageRouter().routeAsync({
      traceId,
      runId,
      facts: buildFacts(frame),
      tenantId: 'tenant-sandbox',
      actorId: 'actor-sandbox',
      environment: 'sandbox',
      functionRules: sandboxFunctionRules,
      pluginRules: sandboxPluginRules,
      pluginHost: this.pluginHost,
      functionDecisionAdapter: this.functionDecisionAdapter,
      pluginDecisionAdapter: this.pluginDecisionAdapter,
      authorizePlugin: () => true
    });
  }

  /**
   * 把路由结果落成 Action 并交给 Workflow 执行。
   *
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @param frame - 结构化语义帧
   * @param route - 两阶段路由结果
   * @returns 执行/待确认/澄清/失败的内部结果联合
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async prepareAndExecute(runId: string, userText: string, frame: SemanticFrame, route: RouteResult): Promise<ExecuteTurnOutcome> {
    if (!route.functionId || !route.pluginId) return { status: 'failed', reply: '路由结果缺少 Function 或 Plugin。', reasonCode: 'route_incomplete' };
    const resolved = this.pluginHost.resolveCandidate(route.functionId, route.pluginId);
    if (!resolved.ok) return { status: 'failed', reply: `路由选中的插件不可用（${resolved.error.code}）。`, reasonCode: resolved.error.code };
    const built = buildActionInput(route.functionId, frame.slots, userText);
    if ('missing' in built) return { status: 'clarification', reply: `还缺少必要信息（${built.missing.join('、')}），请补充完整后再试。`, reasonCode: 'slots_missing' };
    const policy = resolved.value.manifest.policy;
    const action: ActionDefinition = {
      schemaVersion: SCHEMA_VERSIONS.action,
      actionId: `action-sandbox-${String(this.turnCount)}`,
      runId,
      functionId: route.functionId,
      pluginId: route.pluginId,
      idempotencyKey: `${route.functionId}:${SESSION_RUN_ID}:${String(this.turnCount)}`,
      input: built.input,
      riskLevel: policy.riskLevel,
      confirmationRequired: policy.requiresConfirmation
    };
    await this.appendDecisionEvent(runId, frame, route, built.input);
    // 每个回合使用独立 Workflow 实例，事件写入共享 EventLog 以保证全局唯一 ID。
    this.workflow = this.createWorkflow();
    this.workflow.start({ runId, definition: TURN_DEFINITION });
    if (policy.requiresConfirmation) this.workflow.transition({ runId, event: 'request_confirmation' });
    const executed = await this.workflow.execute({
      runId,
      action,
      requiredCapabilities: [...resolved.value.manifest.capabilities],
      grantedCapabilities: [...resolved.value.manifest.capabilities],
      authorized: true,
      executor: this.createExecutor()
    });
    await this.drainWorkflowEvents();
    if (!executed.ok) {
      if (executed.reasonCode === 'confirmation_required') {
        this.pending = { action };
        return { status: 'awaiting_confirmation', action, reply: `即将执行高风险操作「${action.functionId}」（插件 ${action.pluginId}），需要你的确认。` };
      }
      return { status: 'failed', reply: `动作被拒绝：${executed.reasonCode}`, reasonCode: executed.reasonCode };
    }
    this.workflow.transition({ runId, event: 'complete' });
    await this.drainWorkflowEvents();
    return { status: 'executed', action, actionResult: executed.value };
  }

  /**
   * 路由未命中时的兜底回复：brain 走 Response Generator，scripted 走模板。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户输入文本
   * @param reasonCode - 路由未命中的稳定原因码
   * @returns 兜底回复文本，生成失败时回退固定话术
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async fallbackReply(traceId: string, runId: string, userText: string, reasonCode: string): Promise<string> {
    if (this.mode === 'brain') {
      const generated = await new ResponseGeneratorAdapter(this.gateway).generate({
        traceId,
        runId,
        input: {
          userMessage: userText,
          recentMessages: this.recentMessages.slice(-6),
          availableFunctions: ['knowledge.query', 'ticket.create', 'human.transfer'],
          reasonCode
        }
      });
      // 只有生成失败才回退固定话术。
      if (generated.ok) return generated.value.text;
      return FALLBACK_REPLY_TEXT;
    }
    return this.scriptedFallbackReply(userText) ?? FALLBACK_REPLY_TEXT;
  }

  /**
   * 流式兜底回复：brain 模式逐段透传 delta，失败回退非流式兜底；scripted 模式一次性下发模板回复。
   *
   * @param traceId - 链路追踪标识
   * @param runId - 会话运行标识
   * @param userText - 用户输入文本
   * @param reasonCode - 路由失败原因码
   * @param onDelta - 回复增量回调
   * @returns 兜底回复全文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async fallbackReplyStreamed(traceId: string, runId: string, userText: string, reasonCode: string, onDelta: (delta: string) => void): Promise<string> {
    if (this.mode !== 'brain' || !(this.brainProvider instanceof OpenAICompatibleModelProvider)) {
      const reply = await this.fallbackReply(traceId, runId, userText, reasonCode);
      onDelta(reply);
      return reply;
    }
    const profile = this.registry.forRole('response.generate');
    const input: JsonValue = {
      userMessage: userText,
      recentMessages: this.recentMessages.slice(-6),
      availableFunctions: ['knowledge.query', 'ticket.create', 'human.transfer'],
      reasonCode
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
    let streamed = '';
    try {
      const parsed = await this.brainProvider.completeStreamed({ traceId, runId, profile, input, attempt: 1, signal: controller.signal }, (delta) => {
        streamed += delta;
        onDelta(delta);
      });
      const text = readResponseText(parsed);
      if (text !== undefined) return text;
      if (streamed.trim().length > 0) return streamed;
      return this.fallbackReply(traceId, runId, userText, reasonCode);
    } catch {
      if (streamed.trim().length > 0) return streamed;
      return this.fallbackReply(traceId, runId, userText, reasonCode);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * scripted 模式的轻量模板兜底：身份介绍、能力说明和基于最近对话的指令回忆。
   *
   * @param userText - 用户输入文本
   * @returns 模板回复文本，模板覆盖不了时返回 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private scriptedFallbackReply(userText: string): string | undefined {
    const text = userText.trim();
    if (/(刚才|之前|上次|前面)/.test(text)) {
      const lastUser = [...this.recentMessages].reverse().find((message) => message.role === 'user');
      if (lastUser) return `你刚才让我「${lastUser.text.slice(0, 60)}」，这就是你之前交代的事。`;
      return '这是我们对话的开始，你还没有让我做过任何事。';
    }
    if (/(你是谁|你叫什么|自我介绍|你是什么)/.test(text)) {
      return '我是 IAR Agent Sandbox，一个可交互的 IAR 插件沙盒：你输入一句话，我会走完语义抽取、两阶段路由（Function → Plugin）、策略确认和插件执行，并在右侧展示完整的路由证据和事件流。';
    }
    if (/(能做什么|会什么|有什么功能|可以做什么|能干嘛|能干什么)/.test(text)) {
      return '我目前支持三件事：1）查询知识，比如「查一下退款政策」；2）创建工单，比如「帮我提个工单，网络很卡」；3）转接人工客服，比如「转人工」。其中工单和转人工属于高风险操作，执行前需要你确认。';
    }
    return undefined;
  }

  /**
   * 流式回复生成：brain 模式逐段透传 delta，scripted 模式一次性下发模板回复。
   *
   * 流式调用或 iar.response/v1 解析失败时，已 stream 出的原文直接兜底；
   * 一个增量都没收到时退回非流式生成，保持与 turn() 相同的失败话术。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户消息
   * @param action - 已执行动作
   * @param actionResult - 动作执行结果
   * @param onDelta - 回复增量回调
   * @returns 回复文本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async generateReplyStreamed(traceId: string, runId: string, userText: string, action: ActionDefinition, actionResult: ActionResult, onDelta: (delta: string) => void): Promise<string> {
    if (this.mode !== 'brain' || !(this.brainProvider instanceof OpenAICompatibleModelProvider)) {
      const reply = await this.generateReply(traceId, runId, userText, action, actionResult);
      onDelta(reply);
      return reply;
    }
    const profile = this.registry.forRole('response.generate');
    const input: JsonValue = {
      userMessage: userText,
      functionId: action.functionId,
      pluginId: action.pluginId,
      actionStatus: actionResult.status,
      actionOutput: actionResult.output ?? null
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
    let streamed = '';
    try {
      const parsed = await this.brainProvider.completeStreamed({ traceId, runId, profile, input, attempt: 1, signal: controller.signal }, (delta) => {
        streamed += delta;
        onDelta(delta);
      });
      const text = readResponseText(parsed);
      if (text !== undefined) return text;
      if (streamed.trim().length > 0) return streamed;
      return `动作已执行（${action.functionId}），但回复生成失败（model.schema_invalid）。`;
    } catch {
      if (streamed.trim().length > 0) return streamed;
      return this.generateReply(traceId, runId, userText, action, actionResult);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 追加记录路由证据的 decision.created 事件。
   *
   * @param runId - 会话运行标识
   * @param frame - 语义帧
   * @param route - 两阶段路由结果
   * @param input - Action 输入
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async appendDecisionEvent(runId: string, frame: SemanticFrame, route: RouteResult, input: JsonValue): Promise<void> {
    this.decisionEventCount += 1;
    const payload: Record<string, JsonValue> = {
      functionId: route.functionId ?? 'unknown',
      pluginId: route.pluginId ?? 'unknown',
      intent: frame.intent,
      actionName: route.functionId ?? 'unknown',
      semanticConfidence: frame.confidence,
      slots: toSlotMap(frame.slots),
      reasonCode: route.reasonCode,
      input
    };
    if (route.functionDecision?.score !== undefined) payload.functionScore = route.functionDecision.score;
    if (route.pluginDecision?.score !== undefined) payload.pluginScore = route.pluginDecision.score;
    const event: EventEnvelope = {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: `sandbox-decision-${String(this.decisionEventCount)}`,
      eventName: 'decision.created',
      occurredAt: new Date().toISOString(),
      runId,
      correlationId: SESSION_CORRELATION_ID,
      payload
    };
    await this.eventStore.append(event);
    this.projector.apply(event);
  }

  /**
   * 生成 CompactionRequest，token 数用 JSON 字符串长度估算。
   *
   * @param compactSeq - 压缩序号
   * @param occurredAt - 压缩审计时间
   * @param events - 事件快照
   * @param current - 当前可信上下文
   * @param result - 模型压缩结果
   * @returns 压缩服务请求
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private buildCompactionRequest(compactSeq: number, occurredAt: string, events: readonly EventEnvelope[], current: BehaviorContext, result: CompactionResult): CompactionRequest {
    const beforeTokenCount = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    const afterEstimate = JSON.stringify({ summary: result.summary, state: result.state }).length;
    return {
      current,
      runId: SESSION_RUN_ID,
      correlationId: SESSION_CORRELATION_ID,
      occurredAt,
      compactedEventId: `sandbox-compacted-${String(compactSeq)}`,
      failureEventId: `sandbox-compaction-failed-${String(compactSeq)}`,
      events,
      result,
      fromEventId: events[0]!.eventId,
      toEventId: events[events.length - 2]!.eventId,
      firstKeptEntryId: events[events.length - 1]!.eventId,
      beforeTokenCount,
      afterTokenCount: Math.min(afterEstimate, beforeTokenCount),
      summaryVersion: 'summary-v1',
      generatorVersion: 'sandbox-compactor-v1'
    };
  }

  /**
   * 模型压缩失败时手工构造 compaction_failed 事件。
   *
   * @param compactSeq - 压缩序号
   * @param occurredAt - 事件发生时间
   * @param reasonCode - 稳定失败码
   * @param message - 稳定失败消息
   * @param hashBefore - 旧视图关键字段哈希
   * @returns 可追加的失败事件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private buildCompactionFailureEvent(compactSeq: number, occurredAt: string, reasonCode: string, message: string, hashBefore: string): EventEnvelope {
    return {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: `sandbox-compaction-model-failed-${String(compactSeq)}`,
      eventName: 'context.compaction_failed',
      occurredAt,
      runId: SESSION_RUN_ID,
      correlationId: SESSION_CORRELATION_ID,
      payload: { reasonCode, message, previousContextHash: hashBefore }
    };
  }

  /**
   * 调用 Response Generator 生成面向用户的回复。
   *
   * @param traceId - 链路标识
   * @param runId - 运行标识
   * @param userText - 用户消息
   * @param action - 已执行动作
   * @param actionResult - 动作执行结果
   * @returns 回复文本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async generateReply(traceId: string, runId: string, userText: string, action: ActionDefinition, actionResult: ActionResult): Promise<string> {
    const generated = await new ResponseGeneratorAdapter(this.gateway).generate({
      traceId,
      runId,
      input: {
        userMessage: userText,
        functionId: action.functionId,
        pluginId: action.pluginId,
        actionStatus: actionResult.status,
        actionOutput: actionResult.output ?? null
      }
    });
    if (!generated.ok) return `动作已执行（${action.functionId}），但回复生成失败（${generated.error.code}）。`;
    return generated.value.text;
  }

  /**
   * 记录一条用户消息和对应助手回复到最近消息列表。
   *
   * @param userText - 用户消息
   * @param assistantReply - 助手回复
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private pushMessages(userText: string, assistantReply: string): void {
    this.recentMessages.push({ role: 'user', text: userText });
    this.pushAssistantMessage(assistantReply);
  }

  /**
   * 记录一条助手回复，最近消息列表按上限截断。
   *
   * @param assistantReply - 助手回复
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private pushAssistantMessage(assistantReply: string): void {
    this.recentMessages.push({ role: 'assistant', text: assistantReply });
    if (this.recentMessages.length > 20) this.recentMessages.splice(0, this.recentMessages.length - 20);
  }
}

/** 读取 sandbox backend 选择，未配置时保持 JEV 优先的全量 registry。 */
function readSandboxDecisionBackend(): SandboxDecisionBackend | undefined {
  const value = process.env.IAR_SANDBOX_DECISION_BACKEND;
  if (value === undefined || value.length === 0) return undefined;
  if (value === 'jev' || value === 'intent-model') return value;
  throw new Error('IAR_SANDBOX_DECISION_BACKEND 必须是 jev 或 intent-model');
}

/** 创建离线决策模型 provider，模拟 JEV/Intent Model 的统一 iar.decision/v1 输出。 */
function createDecisionModelProvider(): ModelProvider {
  return {
    complete: async (request) => {
      const input = request.input as { request?: DecisionRequest } & Partial<DecisionRequest>;
      const decision = input.request ?? input as DecisionRequest;
      return {
        schemaVersion: SCHEMA_VERSIONS.decision,
        decisionType: decision.decisionType,
        decisionVersion: decision.decisionVersion,
        status: 'choice',
        choice: decision.candidates[0]?.candidateId,
        score: 0.99,
        reasonCode: 'sandbox.choice',
        candidateIds: decision.candidates.map((candidate) => candidate.candidateId)
      };
    }
  };
}

/**
 * 从 provider 输出中读取 iar.response/v1 的 text 字段。
 *
 * @param raw - provider 原始输出
 * @returns 非空 text 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function readResponseText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw : undefined;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const text = (raw as { text?: unknown }).text;
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

/**
 * 把 SemanticFrame 摊平成规则引擎读取的 JSON facts。
 *
 * @param frame - 结构化语义帧
 * @returns 规则评估事实
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function buildFacts(frame: SemanticFrame): RuleEvaluationFacts {
  const semantic: Record<string, JsonValue> = {
    intent: frame.intent,
    confidence: frame.confidence,
    slots: frame.slots,
    references: frame.references
  };
  if (frame.action !== undefined) semantic.action = frame.action;
  return { semantic };
}

/**
 * 从路由结果和语义帧构造调试面板证据。
 *
 * @param route - 两阶段路由结果
 * @param frame - 结构化语义帧
 * @returns 路由证据摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function buildEvidence(route: RouteResult, frame: SemanticFrame): RouteEvidence {
  const evidence: RouteEvidence = {
    status: route.status,
    reasonCode: route.reasonCode,
    semanticIntent: frame.intent,
    semanticConfidence: frame.confidence
  };
  if (route.functionId !== undefined) evidence.functionId = route.functionId;
  if (route.pluginId !== undefined) evidence.pluginId = route.pluginId;
  if (route.functionDecision?.score !== undefined) evidence.functionScore = route.functionDecision.score;
  if (route.pluginDecision?.score !== undefined) evidence.pluginScore = route.pluginDecision.score;
  return evidence;
}

/**
 * 按 Function 把语义槽位和默认值组装成插件输入。
 *
 * @param functionId - 目标 Function
 * @param slots - 抽取到的槽位
 * @param userText - 用户原始输入
 * @returns 插件输入或缺失槽位列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function buildActionInput(functionId: string, slots: Record<string, JsonValue>, userText: string): { input: JsonValue } | { missing: string[] } {
  if (functionId === 'knowledge.query') {
    const query = stringSlot(slots, 'query') ?? (userText.length > 0 ? userText : undefined);
    if (!query) return { missing: ['query'] };
    return { input: { query: query.slice(0, 500), topK: 3 } };
  }
  if (functionId === 'ticket.create') {
    const title = stringSlot(slots, 'title') ?? '用户反馈问题';
    const description = stringSlot(slots, 'description') ?? userText;
    const priorityRaw = stringSlot(slots, 'priority');
    const priority = priorityRaw === 'low' || priorityRaw === 'medium' || priorityRaw === 'high' ? priorityRaw : 'medium';
    if (description.length === 0) return { missing: ['description'] };
    return { input: { title: title.slice(0, 120), description: description.slice(0, 2000), priority } };
  }
  if (functionId === 'human.transfer') {
    const reason = stringSlot(slots, 'reason') ?? '用户请求人工协助';
    const summary = stringSlot(slots, 'summary') ?? userText;
    if (summary.length === 0) return { missing: ['summary'] };
    return { input: { reason: reason.slice(0, 240), summary: summary.slice(0, 2000) } };
  }
  return { missing: [`未知 Function: ${functionId}`] };
}

/**
 * 读取字符串槽位。
 *
 * @param slots - 槽位集合
 * @param key - 槽位名
 * @returns 非空字符串或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function stringSlot(slots: Record<string, JsonValue>, key: string): string | undefined {
  const value = slots[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 把语义槽位转换成 BehaviorContext 的 SlotValue 映射。
 *
 * @param slots - 语义槽位
 * @returns 带 resolved 状态的槽位映射
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toSlotMap(slots: Record<string, JsonValue>): Record<string, SlotValue> {
  return Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, { value, status: 'resolved' as const }]));
}

/**
 * 构造待确认动作摘要。
 *
 * @param action - 完整 Action
 * @returns 摘要对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function summarizeAction(action: ActionDefinition): PendingActionSummary {
  return {
    actionId: action.actionId,
    runId: action.runId,
    functionId: action.functionId,
    pluginId: action.pluginId,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    input: action.input
  };
}
