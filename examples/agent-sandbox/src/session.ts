/** 公开会话入口；路由、回复、流式组件共享 core 中唯一的会话状态。 */
import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import { resolveSandboxTraceId } from './safe-log.js';
import { SandboxSessionStreamTurn } from './session-stream-turn.js';
import { SandboxSessionTurn } from './session-turn.js';
import { SandboxSessionReplies } from './session-replies.js';
import { SandboxSessionRouting } from './session-routing.js';
import { DEFAULT_UNRESOLVED_STREAK_THRESHOLD, MAX_COLLECTION_ATTEMPTS, MAX_UNRESOLVED_STREAK, type ActionDefinition, type BehaviorContext, type CollectionState, type PendingReference, type VerifiedFactRecord } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { confirmationScopeHash, type RouteResult, type SemanticFrame } from '@iar/runtime';
import { SandboxSessionCore, SESSION_RUN_ID } from './session-core.js';
import { buildEvidence, sandboxOperationKind, summarizeAction } from './session-helpers.js';
import { createSelectionState, hasVerifiedFactsForFollowUp, matchesPendingOption } from './session-clarification.js';
import { collectFunctionCandidates } from './function-collector.js';
import { allowsContextFollowUp, applyRouteDiagnostic, finishConfirmedAction, gateIncompleteSemanticFrame, logActionResult, logRouteResult, recordAgentExchange, rejectSelection, resolveNoMatchTurn, resolveSelection, semanticIncompleteClarification } from './session-turn-helpers.js';
import { withConfirmReplySource, withReplySource, type CompactResult, type ConfirmResult, type ExecuteTurnOutcome, type ExtractFrameOutcome, type PendingActionContext, type RouteEvidence, type StreamEvent, type TurnResult } from './session-types.js';
import type { TurnTimingTracker } from './turn-timing.js';
export type { CompactResult, ConfirmResult, PendingActionSummary, ReplySource, RouteEvidence, SandboxDecisionBackend, SandboxMode, SandboxState, StreamEvent, TurnResult, TurnStage } from './session-types.js';
/** 公开会话对话和确认入口。 */
export class IarSandboxSession extends SandboxSessionCore {
  /** 路由和执行操作访问宿主共享状态。 */
  private readonly routing = this.createRouting();
  /** 回复与压缩共享宿主提供的实时状态。 */
  private readonly replies = this.createReplies();
  /** 流式组件只持有宿主能力，重置后仍访问当前状态。 */
  private readonly streaming = this.createStreaming();
  private readonly turnRunner = this.createTurnRunner();
  /** 绑定路由依赖和可变状态，重置不会留下过期引用。 */
  private createRouting(): SandboxSessionRouting {
    const session = this;
    return new SandboxSessionRouting({
      get mode() { return session.mode; }, get registry() { return session.registry; },
      get gateway() { return session.gateway; }, get pluginHost() { return session.pluginHost; },
      get configuration() { return session.configuration; },
      get recentMessages() { return session.recentMessages; },
      get functionDecisionAdapter() { return session.functionDecisionAdapter; },
      get pluginDecisionAdapter() { return session.pluginDecisionAdapter; }, get functionCallAdapter() { return session.functionCallAdapter; }, get nestedRouteAdapter() { return session.nestedRouteAdapter; },
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
      ...(session.configuration.systemPrompt === undefined ? {} : { get agentPrompt() { return session.configuration.systemPrompt; } }),
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
      get functionDescriptors() { return session.pluginHost.descriptors(); },
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
      hasPending: () => session.pending !== null,
      pendingAction: (): PendingActionContext | undefined => session.pending === null ? undefined : summarizeAction(session.pending.action),
      nextTraceId: () => { this.turnCount += 1; return resolveSandboxTraceId(`trace-sandbox-${String(this.turnCount)}`); },
      resolveSelection: (text, context) => session.resolveSelection(text, context),
      rejectSelection: (text, reasonCode) => session.rejectSelection(text, reasonCode),
      collectFunctionCandidates: (context) => session.collectFunctionCandidates(context),
      markUnresolved: (reasonCode) => session.markUnresolved(reasonCode),
      resetClarification: () => session.resetClarification(),
      extractFrame: (traceId, runId, text, behaviorContext, recentMessages, selectedDescriptor, pendingAction) => this.routing.extractFrame(traceId, runId, text, behaviorContext, recentMessages, selectedDescriptor, pendingAction),
      get recentMessages() { return session.recentMessages; },
      get functionDescriptors() { return session.pluginHost.descriptors(); },
      routeFrame: (traceId, runId, frame, behaviorContext, currentMessage, recentMessages, selectedDescriptor) => this.routing.routeFrame(traceId, runId, frame, behaviorContext, currentMessage, recentMessages, selectedDescriptor),
      resolveReferences: (frame, behaviorContext) => this.routing.resolveReferences(frame, behaviorContext),
      prepareAndExecute: (context) => this.routing.prepareAndExecute(context),
      fallbackReplyStreamed: (context, onDelta, onReasoningDelta) => this.replies.fallbackReplyStreamed(context, onDelta, onReasoningDelta),
      generateReplyStreamed: (context, onDelta, onReasoningDelta) => this.replies.generateReplyStreamed(context, onDelta, onReasoningDelta),
      currentBehaviorContext: () => this.projector.current(),
      pushMessages: (text, reply) => this.replies.pushMessages(text, reply),
      piAgent: this.piAgent
    });
  }
  /** 创建普通单轮编排组件，仍通过访问器读取会话当前状态。 */
  private createTurnRunner(): SandboxSessionTurn {
    const session = this;
    return new SandboxSessionTurn({
      whenReady: () => session.whenReady(),
      nextTurnId: () => { session.turnCount += 1; return session.turnCount; },
      hasPending: () => session.pending !== null,
      pendingAction: (): PendingActionContext | undefined => session.pending === null ? undefined : summarizeAction(session.pending.action),
      cancelStalePending: () => session.cancelStalePending(),
      currentBehaviorContext: () => session.projector.current(),
      resolveSelection: (text, context) => session.resolveSelection(text, context),
      rejectSelection: (text, reasonCode) => session.rejectSelection(text, reasonCode),
      extractFrame: (traceId, text, context, recentMessages, selectedDescriptor, pendingAction) => session.routing.extractFrame(traceId, SESSION_RUN_ID, text, context, recentMessages, selectedDescriptor, pendingAction),
      recentMessages: () => session.recentMessages,
      markUnresolved: (reasonCode, pendingReference) => session.markUnresolved(reasonCode, pendingReference),
      pushMessage: (text, reply) => session.replies.pushMessages(text, reply),
      routeNormalTurn: (context) => session.routeNormalTurn(context)
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
    return this.whenReady().then(() => this.streaming.turnStreamed(text, emit)).then((result) => recordAgentExchange(this.piAgent, text, withReplySource(result)));
  }

  /** Bridge 流式输入保持 pass_through；@author lvdaxianer@yeah.net @date 2026-10-22 */
  public bridgeTurnStreamed(text: string, emit: (event: StreamEvent) => void): Promise<TurnResult> { return this.whenReady().then(() => this.streaming.turnStreamed(text, emit, true)).then((result) => withReplySource(result)); }
  /**
   * 执行一轮对话：抽取 → 路由 → 策略/确认 → 执行 → 回复生成。
   *
   * @param text - 用户输入文本
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async turn(text: string): Promise<TurnResult> {
    return recordAgentExchange(this.piAgent, text, withReplySource(await this.turnRunner.run(text, false)));
  }

  /**
   * 执行一轮供 Pi bridge 使用的输入。
   * IAR 明确没有业务路由时返回 pass_through；待确认状态不会被普通输入取消。
   * @param text - Pi 用户输入
   * @returns IAR bridge 处置结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-20
   */
  public async bridgeTurn(text: string): Promise<TurnResult> {
    return withReplySource(await this.turnRunner.run(text, true));
  }
  /**
   * 执行普通对话的路由并分派未命中或动作路径。
   * @param context - 用户输入、链路标识及抽取结果
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async routeNormalTurn(context: { userText: string; traceId: string; behaviorContext: BehaviorContext; extracted: Extract<ExtractFrameOutcome, { ok: true }>; timing: TurnTimingTracker; passThroughOnNoMatch: boolean; selectedDescriptor?: PluginDescriptor }): Promise<TurnResult> {
    const { userText, traceId, behaviorContext, extracted, timing, passThroughOnNoMatch, selectedDescriptor } = context;
    const references = this.routing.resolveReferences(extracted.frame, behaviorContext);
    if (!references.ok) return this.finishNormalFallback({ userText, traceId, behaviorContext, timing, evidence: { status: 'rejected', reasonCode: references.reasonCode, semanticIntent: extracted.frame.intent, semanticConfidence: extracted.frame.confidence }, ...(references.pendingReference === undefined ? {} : { pendingReference: references.pendingReference }), ...(references.candidates === undefined ? {} : { referenceCandidates: references.candidates }) });
    if (behaviorContext.pendingReference !== undefined) await this.resetClarification();
    const routeContext = this.projector.current();
    const incomplete = gateIncompleteSemanticFrame(extracted.frame, traceId, timing, userText, allowsContextFollowUp(extracted.frame, routeContext, userText) || this.piAgent !== undefined);
    if (incomplete) {
      const resolved = await resolveNoMatchTurn({ piAgent: this.piAgent, pushMessages: this.replies.pushMessages.bind(this.replies), passThroughOnNoMatch, userText, evidence: incomplete, behaviorContext: routeContext, selectedDescriptor, functionDescriptors: this.pluginHost.descriptors() });
      return resolved ?? this.finishNormalFallback({ userText, traceId, behaviorContext: routeContext, timing, evidence: incomplete, resolvedReferences: references.references });
    }
    timing.start('route.select');
    const usesNestedRoute = extracted.frame.action !== 'unknown' && extracted.frame.intent !== 'unknown';
    if (usesNestedRoute) timing.start('route.propose');
    let route: Awaited<ReturnType<SandboxSessionRouting['routeFrame']>>;
    let routeCompleted = false;
    try {
      route = await this.routing.routeFrame(traceId, SESSION_RUN_ID, extracted.frame, routeContext, userText, this.recentMessages, selectedDescriptor);
      routeCompleted = true;
    } finally {
      if (usesNestedRoute) timing.end('route.propose', routeCompleted ? 'completed' : 'failed');
    }
    timing.end('route.select');
    logRouteResult(traceId, route);
    const evidence = buildEvidence(route, extracted.frame);
    // 抽取降级须保留在返回的路由证据中。
    if (extracted.semanticFallback) evidence.semanticFallback = true;
    if (route.status !== 'matched' || !route.functionId || !route.pluginId) {
      const recovered = await this.collectFunctionCandidates({ userText, route, frame: extracted.frame, evidence });
      if (recovered.result) return recovered.result;
      if (recovered.route) {
        route = recovered.route;
        evidence.status = route.status;
        evidence.reasonCode = route.reasonCode;
        if (route.functionId === undefined) delete evidence.functionId; else evidence.functionId = route.functionId;
        if (route.pluginId === undefined) delete evidence.pluginId; else evidence.pluginId = route.pluginId;
        logRouteResult(traceId, route);
      }
      else {
      const resolved = await resolveNoMatchTurn({ piAgent: this.piAgent, pushMessages: this.replies.pushMessages.bind(this.replies), passThroughOnNoMatch, userText, evidence, behaviorContext, selectedDescriptor, functionDescriptors: this.pluginHost.descriptors() });
      return resolved ?? this.finishNormalFallback({ userText, traceId, behaviorContext: routeContext, timing, evidence, resolvedReferences: references.references });
      }
    }
    timing.start('action.execute');
    if (this.pending !== null) await this.cancelStalePending();
    const outcome = await this.routing.prepareAndExecute({ runId: SESSION_RUN_ID, userText, frame: extracted.frame, route, behaviorContext: routeContext });
    timing.end('action.execute');
    logActionResult(traceId, outcome);
    applyRouteDiagnostic(evidence, traceId, outcome);
    return this.finishNormalOutcome({ userText, traceId, timing, evidence, outcome });
  }
  /**
   * 生成路由未命中时的普通回复，超限内容不写入历史。
   * 没有动作执行时，回复超限表现为失败而非正常澄清。
   * @param context - 当前输入、链路和路由证据
   * @returns 澄清结果或明确的超限错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalFallback(context: { userText: string; traceId: string; behaviorContext: BehaviorContext; timing: TurnTimingTracker; evidence: RouteEvidence; resolvedReferences?: import('./session-types.js').ResolvedFactReference[]; pendingReference?: PendingReference; referenceCandidates?: VerifiedFactRecord[] }): Promise<TurnResult> {
    const { userText, traceId, behaviorContext, timing, evidence, resolvedReferences, pendingReference, referenceCandidates } = context;
    if (!hasVerifiedFactsForFollowUp(behaviorContext, evidence, userText) && !matchesPendingOption(behaviorContext, userText)) await this.markUnresolved(evidence.reasonCode, pendingReference);
    const currentBehaviorContext = this.projector.current();
    const deterministicReply = semanticIncompleteClarification(evidence);
    if (deterministicReply !== undefined) {
      timing.skip('response.generate');
      this.replies.pushMessages(userText, deterministicReply);
      return { status: 'clarification', reply: deterministicReply, route: evidence, reasonCode: evidence.reasonCode };
    }
    // 未命中功能时只允许生成澄清回复，不能在兜底阶段隐式执行插件。
    timing.start('response.generate');
    const reply = await trackModelResponseLimit(() => this.replies.fallbackReply({ traceId, runId: SESSION_RUN_ID, userText, behaviorContext: currentBehaviorContext, recentMessages: this.recentMessages, functionDescriptors: this.pluginHost.descriptors(), reasonCode: evidence.reasonCode, ...(resolvedReferences === undefined ? {} : { resolvedReferences }), ...(referenceCandidates === undefined ? {} : { referenceCandidates }) })).catch((error: unknown) => {
      // 非超限错误必须继续向调用方传播。
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    timing.end('response.generate', reply === undefined ? 'failed' : 'completed');
    if (reply === undefined) return { status: 'failed', reply: '模型回复超限，回复未完成。', route: evidence, reasonCode: 'model_response_too_large' };
    this.replies.pushMessages(userText, reply);
    return { status: 'clarification', reply, route: evidence, reasonCode: evidence.reasonCode, ...(resolvedReferences && resolvedReferences.length > 0 ? { disposition: 'context_answered' as const } : {}) };
  }
  /**
   * 将动作阶段各终态转换成普通对话结果。
   * @param context - 当前输入、链路、路由证据和动作结果
   * @returns 本轮对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalOutcome(context: { userText: string; traceId: string; timing: TurnTimingTracker; evidence: RouteEvidence; outcome: ExecuteTurnOutcome }): Promise<TurnResult> {
    const { userText, traceId, timing, evidence, outcome } = context;
    // 尚未执行的终态先写入对话历史，不生成动作回复。
    if (outcome.status === 'awaiting_confirmation') {
      evidence.operationKind = outcome.operationKind;
      await this.resetClarification();
      this.replies.pushMessages(userText, outcome.reply);
      return { status: 'awaiting_confirmation', reply: outcome.reply, route: evidence, pending: summarizeAction(outcome.action) };
    }
    if (outcome.status === 'failed' || outcome.status === 'clarification') {
      if (outcome.status === 'clarification') await this.markUnresolved(outcome.reasonCode);
      this.replies.pushMessages(userText, outcome.reply);
      return { status: outcome.status, reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode };
    }
    return this.finishNormalExecution({ userText, traceId, timing, evidence, outcome });
  }
  /**
   * 为已执行动作生成普通回复，保留动作成功和回复超限的区别。
   * 回复失败不能抹去动作结果，也不能将不完整文本存入历史。
   * @param context - 输入、链路、路由证据和已执行动作
   * @returns 含动作结果的对话结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected async finishNormalExecution(context: { userText: string; traceId: string; timing: TurnTimingTracker; evidence: RouteEvidence; outcome: Extract<ExecuteTurnOutcome, { status: 'executed' }> }): Promise<TurnResult> {
    const { userText, traceId, timing, evidence, outcome } = context;
    // 动作已经落地后，模型回复失败也必须保留 executed 事实，禁止重试动作。
    await this.resetClarification();
    evidence.operationKind = outcome.operationKind;
    timing.start('response.generate');
    const reply = await trackModelResponseLimit(() => this.replies.generateReply({ traceId, runId: SESSION_RUN_ID, userText, behaviorContext: this.projector.current(), recentMessages: this.recentMessages, functionDescriptors: this.pluginHost.descriptors(), action: outcome.action, actionResult: outcome.actionResult, operationKind: outcome.operationKind })).catch((error: unknown) => {
      // 非超限错误保持原有传播方式。
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    timing.end('response.generate', reply === undefined ? 'failed' : 'completed');
    if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', route: evidence, actionResult: outcome.actionResult, reasonCode: 'model_response_too_large' };
    if (reply.length > 0) this.replies.pushMessages(userText, reply);
    return { status: 'executed', reply, route: evidence, actionResult: outcome.actionResult };
  }
  /** 累加未解决状态，达到阈值时将当前授权候选转换为动态选择。 */
  public async collectFunctionCandidates(context: { userText: string; route: RouteResult; frame: SemanticFrame; evidence: RouteEvidence }): Promise<{ route?: RouteResult; result?: TurnResult }> {
    const current = this.projector.current();
    const previousAttempt = current.collection?.kind === 'function' ? current.collection.attempt : 0;
    const pluginId = context.route.pluginId ?? context.frame.pluginId;
    const functionId = context.route.functionId ?? (context.frame.intent === 'unknown' ? undefined : context.frame.intent);
    if (pluginId === undefined && functionId === undefined) return {};
    const result = collectFunctionCandidates(this.pluginHost.descriptors(), {
      ...(pluginId === undefined ? {} : { pluginId }),
      ...(functionId === undefined ? {} : { functionId }),
      attempt: Math.min(MAX_COLLECTION_ATTEMPTS, previousAttempt + 1)
    });
    if (result.status === 'empty') return {};
    if (result.status === 'selected') return { route: { ...context.route, status: 'matched', reasonCode: 'route_recovered', functionId: result.descriptor.functionId, pluginId: result.descriptor.pluginId } };
    const candidateKeys = result.state.candidateKeys ?? [];
    const clarification = { mode: 'selection' as const, unresolvedStreak: current.clarification?.unresolvedStreak ?? 0, reasonCode: 'function_collection_required', candidateVersion: candidateKeys.join('|'), candidateKeys };
    await this.updateClarificationState(clarification, { kind: 'selection', status: 'required', options: result.options }, null, result.state);
    const reply = ['请从当前可用能力中选择要使用的 Function：', ...result.options.map((option, index) => `${index + 1}. ${option.label}（${option.key}）`)].join('\n');
    this.replies.pushMessages(context.userText, reply);
    return { result: { status: 'clarification', reply, route: { ...context.evidence, status: 'clarification', reasonCode: 'function_collection_required' }, reasonCode: 'function_collection_required' } };
  }

  /** 累加未解决状态，达到阈值时将当前授权候选转换为动态选择。 */
  public async markUnresolved(reasonCode: string, pendingReference?: PendingReference): Promise<void> {
    const current = this.projector.current();
    const streak = Math.min(MAX_UNRESOLVED_STREAK, (current.clarification?.unresolvedStreak ?? 0) + 1);
    const descriptors = this.pluginHost.descriptors();
    if (streak >= DEFAULT_UNRESOLVED_STREAK_THRESHOLD && descriptors.length > 0) {
      const selection = createSelectionState(descriptors, streak, reasonCode);
      await this.updateClarificationState(selection.state, { kind: 'selection', status: 'required', options: selection.options }, null);
      return;
    }
    await this.updateClarificationState({ mode: 'unresolved', unresolvedStreak: streak, reasonCode }, current.pending, pendingReference ?? null);
  }

  /** 成功进入确认或执行阶段后清除旧的 unresolved 状态。 */
  public async resetClarification(): Promise<void> {
    await this.updateClarificationState({ mode: 'none', unresolvedStreak: 0 }, { kind: 'input', status: 'none' }, null, null);
  }

  /** 解析待选择的候选键，只接受当前启用且授权的候选快照。 */
  public resolveSelection(text: string, context: BehaviorContext): { descriptor?: PluginDescriptor; invalid: boolean; reasonCode: string } { return resolveSelection(this.pluginHost.descriptors(), text, context); }
  /** 对过期或非法候选选择 fail-closed，不触发语义路由或插件执行。 */
  public async rejectSelection(userText: string, reasonCode: string): Promise<TurnResult> { return rejectSelection(this.replies, userText, reasonCode); }
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
    const result = accepted ? await this.executeConfirmation(action) : await this.cancelConfirmation(action);
    return recordAgentExchange(this.piAgent, accepted ? '（确认执行）' : '（取消操作）', withConfirmReplySource(result));
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
    const operationKind = resolved.ok ? sandboxOperationKind(action.functionId, action.input, resolved.value.functions.get(action.functionId)?.operations ?? []) : 'action';
    return finishConfirmedAction({ replies: this.replies, projector: this.projector, recentMessages: this.recentMessages, functionDescriptors: this.pluginHost.descriptors(), turnCount: this.turnCount }, action, executed.value, operationKind);
  }
}
