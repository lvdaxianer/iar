/** 公开会话对话和确认入口。
 * 路由、回复、流式组件共享 core 中唯一的事件、投影、工作流和待确认状态。
 * HTTP 会话管理器负责入口串行及独立会话的 actionId 校验。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import { resolveSandboxTraceId } from './safe-log.js';
import { SandboxSessionStreamTurn } from './session-stream-turn.js';
import { SandboxSessionReplies } from './session-replies.js';
import { SandboxSessionRouting } from './session-routing.js';
import type { ActionDefinition, ActionResult, BehaviorContext } from '@iar/contracts';
import { confirmationScopeHash } from '@iar/workflow';
import { SandboxSessionCore, SESSION_RUN_ID } from './session-core.js';
import { buildEvidence, summarizeAction } from './session-helpers.js';
import type { CompactResult, ConfirmResult, ExecuteTurnOutcome, ExtractFrameOutcome, RouteEvidence, StreamEvent, TurnResult } from './session-types.js';
export type { CompactResult, ConfirmResult, PendingActionSummary, RouteEvidence, SandboxDecisionBackend, SandboxMode, SandboxState, StreamEvent, TurnResult, TurnStage } from './session-types.js';

/** 公开会话对话和确认入口。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class IarSandboxSession extends SandboxSessionCore {
  /** 路由和执行操作访问宿主共享状态。 */
  private readonly routing = this.createRouting();
  /** 回复与压缩共享宿主提供的实时状态。 */
  private readonly replies = this.createReplies();
  /** 流式组件只持有宿主能力，重置后仍访问当前状态。 */
  private readonly streaming = this.createStreaming();

  /** 绑定路由依赖和可变状态，重置不会留下过期引用。
   * @returns 使用当前会话状态的路由组件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private createRouting(): SandboxSessionRouting {
    const session = this;
    return new SandboxSessionRouting({
      get mode() { return session.mode; }, get registry() { return session.registry; },
      get gateway() { return session.gateway; }, get pluginHost() { return session.pluginHost; },
      get recentMessages() { return session.recentMessages; },
      get functionDecisionAdapter() { return session.functionDecisionAdapter; },
      get pluginDecisionAdapter() { return session.pluginDecisionAdapter; },
      get turnCount() { return session.turnCount; },
      get decisionEventCount() { return session.decisionEventCount; }, set decisionEventCount(value) { session.decisionEventCount = value; },
      get eventStore() { return session.eventStore; }, get projector() { return session.projector; },
      get workflow() { return session.workflow; }, set workflow(value) { session.workflow = value; },
      get pending() { return session.pending; }, set pending(value) { session.pending = value; },
      createWorkflow: () => session.createWorkflow(), createExecutor: () => session.createExecutor(),
      drainWorkflowEvents: () => session.drainWorkflowEvents()
    });
  }

  /** 创建回复组件，访问器避免重置后引用旧的会话状态。
   * @returns 使用当前会话依赖的回复组件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private createReplies(): SandboxSessionReplies {
    const session = this;
    return new SandboxSessionReplies({
      get mode() { return session.mode; },
      get brainProvider() { return session.brainProvider; },
      get registry() { return session.registry; },
      get gateway() { return session.gateway; },
      get eventStore() { return session.eventStore; },
      get projector() { return session.projector; },
      recordMessage: (message) => session.recordMessage(message),
      publishEvent: (event) => session.publishPersistenceEvent(event),
      queueSnapshot: (eventId) => session.queueSnapshotAfterCompaction(eventId),
      updateClarification: (pending) => session.updateClarification(pending),
      get recentMessages() { return session.recentMessages; },
      get recentMessageLimit() { return session.recentMessageLimit; },
      get recentMessageMaxChars() { return session.recentMessageMaxChars; },
      get compactCount() { return session.compactCount; },
      set compactCount(value) { session.compactCount = value; }
    });
  }

  /** 压缩当前会话，并保留原有公开入口。
   * @returns 压缩结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  public compact(): Promise<CompactResult> { return this.whenReady().then(() => this.replies.compact()); }

  /** 将会话方法绑定给流式编排，避免另一份事件与历史状态。
   * @returns 使用当前会话能力的流式组件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  private createStreaming(): SandboxSessionStreamTurn {
    const session = this;
    return new SandboxSessionStreamTurn({
      cancelStalePending: () => this.cancelStalePending(),
      nextTraceId: () => { this.turnCount += 1; return resolveSandboxTraceId(`trace-sandbox-${String(this.turnCount)}`); },
      extractFrame: (traceId, runId, text, behaviorContext, recentMessages) => this.routing.extractFrame(traceId, runId, text, behaviorContext, recentMessages),
      get recentMessages() { return session.recentMessages; },
      routeFrame: (traceId, runId, frame, behaviorContext, currentMessage) => this.routing.routeFrame(traceId, runId, frame, behaviorContext, currentMessage),
      prepareAndExecute: (context) => this.routing.prepareAndExecute(context),
      fallbackReplyStreamed: (context, onDelta) => this.replies.fallbackReplyStreamed(context, onDelta),
      generateReplyStreamed: (context, onDelta) => this.replies.generateReplyStreamed(context, onDelta),
      currentBehaviorContext: () => this.projector.current(),
      pushMessages: (text, reply) => this.replies.pushMessages(text, reply)
    });
  }

  /** 在当前会话中执行流式对话并发送阶段与终态。
   * @param text - 用户输入
   * @param emit - 流式事件接收器
   * @returns 与 done 事件一致的结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  public turnStreamed(text: string, emit: (event: StreamEvent) => void): Promise<TurnResult> {
    return this.whenReady().then(() => this.streaming.turnStreamed(text, emit));
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
    await this.whenReady();
    const userText = text.trim();
    // 新一轮输入会结束上一轮未处理的确认，避免旧动作占用当前语义上下文。
    // 本方法只编排当前轮次，事件投影和回复组件负责各自的状态边界。
    await this.cancelStalePending();
    this.turnCount += 1;
    const traceId = resolveSandboxTraceId(`trace-sandbox-${String(this.turnCount)}`);
    const behaviorContext = this.projector.current();
    const extracted = await this.routing.extractFrame(traceId, SESSION_RUN_ID, userText, behaviorContext, this.recentMessages);
    // 语义失败仍写入历史，保持原有对话恢复行为。
    if (!extracted.ok) {
      this.replies.pushMessages(userText, extracted.reply);
      return { status: 'failed', reply: extracted.reply, route: extracted.route, reasonCode: extracted.reasonCode };
    }
    return this.routeNormalTurn({ userText, traceId, behaviorContext, extracted });
  }


  /**
   * 执行普通对话的路由并分派未命中或动作路径。
   * @param context - 用户输入、链路标识及抽取结果
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async routeNormalTurn(context: { userText: string; traceId: string; behaviorContext: BehaviorContext; extracted: Extract<ExtractFrameOutcome, { ok: true }> }): Promise<TurnResult> {
    const { userText, traceId, behaviorContext, extracted } = context;
    const route = await this.routing.routeFrame(traceId, SESSION_RUN_ID, extracted.frame, behaviorContext, userText);
    const evidence = buildEvidence(route, extracted.frame);
    // 抽取降级须保留在返回的路由证据中。
    if (extracted.semanticFallback) evidence.semanticFallback = true;
    if (route.status !== 'matched' || !route.functionId || !route.pluginId) {
      return this.finishNormalFallback({ userText, traceId, behaviorContext, evidence });
    }
    const outcome = await this.routing.prepareAndExecute({ runId: SESSION_RUN_ID, userText, frame: extracted.frame, route, behaviorContext });
    return this.finishNormalOutcome({ userText, traceId, evidence, outcome });
  }


  /**
   * 生成路由未命中时的普通回复，超限内容不写入历史。
   * 没有动作执行时，回复超限表现为失败而非正常澄清。
   * @param context - 当前输入、链路和路由证据
   * @returns 澄清结果或明确的超限错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalFallback(context: { userText: string; traceId: string; behaviorContext: BehaviorContext; evidence: RouteEvidence }): Promise<TurnResult> {
    const { userText, traceId, behaviorContext, evidence } = context;
    // 未命中功能时只允许生成澄清回复，不能在兜底阶段隐式执行插件。
    const reply = await trackModelResponseLimit(() => this.replies.fallbackReply({ traceId, runId: SESSION_RUN_ID, userText, behaviorContext, recentMessages: this.recentMessages, reasonCode: evidence.reasonCode })).catch((error: unknown) => {
      // 非超限错误必须继续向调用方传播。
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    if (reply === undefined) return { status: 'failed', reply: '模型回复超限，回复未完成。', route: evidence, reasonCode: 'model_response_too_large' };
    this.replies.pushMessages(userText, reply);
    return { status: 'clarification', reply, route: evidence, reasonCode: evidence.reasonCode };
  }


  /**
   * 将动作阶段各终态转换成普通对话结果。
   * @param context - 当前输入、链路、路由证据和动作结果
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalOutcome(context: { userText: string; traceId: string; evidence: RouteEvidence; outcome: ExecuteTurnOutcome }): Promise<TurnResult> {
    const { userText, traceId, evidence, outcome } = context;
    // 尚未执行的终态先写入对话历史，不生成动作回复。
    if (outcome.status === 'awaiting_confirmation') {
      this.replies.pushMessages(userText, outcome.reply);
      return { status: 'awaiting_confirmation', reply: outcome.reply, route: evidence, pending: summarizeAction(outcome.action) };
    }
    if (outcome.status === 'failed' || outcome.status === 'clarification') {
      this.replies.pushMessages(userText, outcome.reply);
      return { status: outcome.status, reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode };
    }
    return this.finishNormalExecution({ userText, traceId, evidence, outcome });
  }


  /**
   * 为已执行动作生成普通回复，保留动作成功和回复超限的区别。
   * 回复失败不能抹去动作结果，也不能将不完整文本存入历史。
   * @param context - 输入、链路、路由证据和已执行动作
   * @returns 含动作结果的对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalExecution(context: { userText: string; traceId: string; evidence: RouteEvidence; outcome: Extract<ExecuteTurnOutcome, { status: 'executed' }> }): Promise<TurnResult> {
    const { userText, traceId, evidence, outcome } = context;
    // 动作已经落地后，模型回复失败也必须保留 executed 事实，禁止重试动作。
    const reply = await trackModelResponseLimit(() => this.replies.generateReply({ traceId, runId: SESSION_RUN_ID, userText, behaviorContext: this.projector.current(), recentMessages: this.recentMessages, action: outcome.action, actionResult: outcome.actionResult })).catch((error: unknown) => {
      // 非超限错误保持原有传播方式。
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', route: evidence, actionResult: outcome.actionResult, reasonCode: 'model_response_too_large' };
    this.replies.pushMessages(userText, reply);
    return { status: 'executed', reply, route: evidence, actionResult: outcome.actionResult };
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
    await this.whenReady();
    // 确认入口只消费当前会话的 pending，不接受客户端重新构造的动作对象。
    if (!this.pending) return { status: 'failed', reply: '当前没有待确认的操作。', reasonCode: 'no_pending_confirmation' };
    const { action } = this.pending;
    // 取消路径不调用执行器，避免产生副作用。
    if (!accepted) return this.cancelConfirmation(action);
    return this.executeConfirmation(action);
  }

  /** 取消当前动作并先投影工作流事件。
   * @param action - 用户取消的待确认动作
   * @returns 取消结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async cancelConfirmation(action: ActionDefinition): Promise<ConfirmResult> {
    // 取消也要写入工作流事件，确保结构化上下文不会遗漏用户的安全选择。
    this.workflow.cancel(action.runId);
    await this.drainWorkflowEvents();
    this.pending = null;
    const reply = '已取消该操作，未产生任何副作用。';
    this.replies.pushAssistantMessage(reply);
    return { status: 'cancelled', reply };
  }

  /** 验证确认并执行动作，再投影执行结果。
   * 确认使用动作完整范围哈希，执行前重新解析插件能力。
   * 执行结束或工作流拒绝后清除 pending，避免重复确认。
   * @param action - 当前待确认动作
   * @returns 执行或失败结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async executeConfirmation(action: ActionDefinition): Promise<ConfirmResult> {
    const runId = action.runId;
    // 确认时重新校验范围哈希和插件能力，防止客户端改写待确认动作。
    const confirmed = this.workflow.confirm({ runId, action, scopeHash: confirmationScopeHash(action), confirmedAt: new Date().toISOString() });
    if (!confirmed.ok) return { status: 'failed', reply: `确认失败：${confirmed.reasonCode}`, reasonCode: confirmed.reasonCode };
    const resolved = this.pluginHost.resolveCandidate(action.functionId, action.pluginId);
    const capabilities = resolved.ok ? [...resolved.value.manifest.capabilities] : [];
    const executed = await this.workflow.execute({ runId, action, requiredCapabilities: capabilities, grantedCapabilities: capabilities, authorized: true, executor: this.createExecutor() });
    await this.drainWorkflowEvents();
    if (!executed.ok) {
      this.pending = null;
      return { status: 'failed', reply: `确认后执行失败：${executed.reasonCode}`, reasonCode: executed.reasonCode };
    }
    this.pending = null;
    this.workflow.transition({ runId, event: 'complete' });
    await this.drainWorkflowEvents();
    return this.finishConfirmedAction(action, executed.value);
  }

  /** 为已确认执行的动作生成回复，超限时保留成功状态。
   * 仅把完整的助手回复写入历史；超限时显式提示不要重复执行。
   * @param action - 已执行动作
   * @param actionResult - 动作执行结果
   * @returns 含动作结果的确认响应
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async finishConfirmedAction(action: ActionDefinition, actionResult: ActionResult): Promise<ConfirmResult> {
    const reply = await trackModelResponseLimit(() => this.replies.generateReply({ traceId: resolveSandboxTraceId(`trace-sandbox-confirm-${String(this.turnCount)}`), runId: action.runId, userText: '（确认执行）', behaviorContext: this.projector.current(), recentMessages: this.recentMessages, action, actionResult })).catch((error: unknown) => {
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', actionResult, reasonCode: 'model_response_too_large' };
    this.replies.pushAssistantMessage(reply);
    return { status: 'executed', reply, actionResult };
  }

}
