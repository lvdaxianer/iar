import { ModelResponseLimitError, trackModelResponseLimit } from './models/model-transport.js';
import { SESSION_RUN_ID } from './session-core.js';
import { buildEvidence, summarizeAction } from './session-helpers.js';
import type { ActionDefinition, ActionResult, BehaviorContext, PendingReference, VerifiedFactRecord } from '@iar/contracts';
import type { SemanticFrame } from '@iar/decision';
import type { RouteResult } from '@iar/runtime';
import type { PluginDescriptor } from '@iar/plugins';
import type { ExecuteTurnOutcome, ExtractFrameOutcome, ReferenceResolution, ResolvedFactReference, RouteEvidence, StreamEvent, TurnResult } from './session-types.js';

/** 流式编排所需的会话能力，状态和资源仍由宿主唯一持有。 */
export type StreamTurnContext = {
  /** 新轮次开始前撤销旧的待确认动作。 */
  cancelStalePending: () => Promise<void>;
  /** 与普通入口共用轮次计数和追踪标识生成。 */
  nextTraceId: () => string;
  /** 选择状态只接受当前授权候选；无效键必须在语义抽取前终止。 */
  resolveSelection: (text: string, context: BehaviorContext) => { descriptor?: PluginDescriptor; invalid: boolean; reasonCode: string };
  rejectSelection: (userText: string, reasonCode: string) => Promise<TurnResult>;
  markUnresolved: (reasonCode: string, pendingReference?: PendingReference) => Promise<void>;
  resetClarification: () => Promise<void>;
  /** 与普通入口共用语义抽取及路由，确保相同的策略边界。 */
  extractFrame: (traceId: string, runId: string, text: string, behaviorContext: BehaviorContext, recentMessages: Array<{ role: string; text: string }>, selectedDescriptor?: PluginDescriptor) => Promise<ExtractFrameOutcome>;
  /** 当前会话的有界原文窗口，普通与流式入口必须读取同一份状态。 */
  recentMessages: Array<{ role: string; text: string }>;
  /** 当前启用 Plugin 的动态能力描述。 */
  functionDescriptors: PluginDescriptor[];
  routeFrame: (traceId: string, runId: string, frame: SemanticFrame, behaviorContext: BehaviorContext, currentMessage: string, recentMessages: Array<{ role: string; text: string }>, selectedDescriptor?: PluginDescriptor) => Promise<RouteResult>;
  resolveReferences: (frame: SemanticFrame, behaviorContext: BehaviorContext) => ReferenceResolution;
  prepareAndExecute: (context: { runId: string; userText: string; frame: SemanticFrame; route: RouteResult; behaviorContext: BehaviorContext }) => Promise<ExecuteTurnOutcome>;
  /** 兜底与执行后回复分别保留增量回调和超限错误。 */
  fallbackReplyStreamed: (context: { traceId: string; runId: string; userText: string; reasonCode: string; behaviorContext: BehaviorContext; recentMessages: Array<{ role: string; text: string }>; functionDescriptors: PluginDescriptor[]; resolvedReferences?: ResolvedFactReference[] }, onDelta: (delta: string) => void) => Promise<string>;
  generateReplyStreamed: (context: { traceId: string; runId: string; userText: string; action: ActionDefinition; actionResult: ActionResult; behaviorContext: BehaviorContext; recentMessages: Array<{ role: string; text: string }>; functionDescriptors: PluginDescriptor[] }, onDelta: (delta: string) => void) => Promise<string>;
  currentBehaviorContext: () => BehaviorContext;
  /** 仅完整回复可写入宿主持有的历史。 */
  pushMessages: (userText: string, reply: string) => void;
};

/** 流式对话阶段和终态。
 * 依赖回复层的模型、历史与路由能力，不单独拥有会话状态。
 * 阶段事件先于对应工作，终态事件携带与返回值相同的结果。
 * 底层模型传输限制累计响应字节，超限信息不会被当作普通增量。
 * 排队与流取消的生命周期由 HTTP 会话管理器负责。
 * 此层不进行自动重试，防止重复执行已完成的动作。
 * 重置与释放仍由唯一的 core 宿主负责。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionStreamTurn {
  /** 依赖注入宿主会话能力，不复制可变状态。
   * @param context - 流式处理使用的会话操作
   * @author lvdaxianer@yeah.net
   * @date 2026-10-19
   */
  public constructor(private readonly context: StreamTurnContext) {}
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
    await this.context.cancelStalePending();
    const traceId = this.context.nextTraceId();
    const behaviorContext = this.context.currentBehaviorContext();
    const selection = this.context.resolveSelection(userText, behaviorContext);
    if (selection.invalid) {
      const result = await this.context.rejectSelection(userText, selection.reasonCode);
      emit({ type: 'done', result });
      return result;
    }
    const extracted = await this.context.extractFrame(traceId, SESSION_RUN_ID, userText, behaviorContext, this.context.recentMessages, selection.descriptor);
    const result = await this.finishStreamExtraction({ userText, traceId, emit, behaviorContext, extracted, ...(selection.descriptor === undefined ? {} : { selectedDescriptor: selection.descriptor }) });
    emit({ type: 'done', result });
    return result;
  }

  /** 处理抽取失败或继续流式路由。
   * 抽取失败不会发送动作或回复阶段，也不会尝试插件执行。
   * @param context - 输入、追踪、事件回调和语义结果
   * @returns 本轮结果，不发送终态事件
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async finishStreamExtraction(context: { userText: string; traceId: string; emit: (event: StreamEvent) => void; behaviorContext: BehaviorContext; extracted: ExtractFrameOutcome; selectedDescriptor?: PluginDescriptor }): Promise<TurnResult> {
    const { userText, extracted } = context;
    // 抽取失败仍与普通入口一样保存失败说明。
    if (!extracted.ok) {
      this.context.pushMessages(userText, extracted.reply);
      return { status: 'failed', reply: extracted.reply, route: extracted.route, reasonCode: extracted.reasonCode };
    }
    return this.routeStreamTurn({ ...context, extracted });
  }

  /** 保持路由和动作阶段的流式通知顺序。
   * 无匹配路由时进入回复兜底，不发送动作阶段。
   * 已降级的语义抽取必须保留在结果证据中。
   * @param context - 已成功抽取的对话上下文
   * @returns 本轮结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async routeStreamTurn(context: { userText: string; traceId: string; emit: (event: StreamEvent) => void; behaviorContext: BehaviorContext; extracted: Extract<ExtractFrameOutcome, { ok: true }>; selectedDescriptor?: PluginDescriptor }): Promise<TurnResult> {
    const { userText, traceId, emit, behaviorContext, extracted, selectedDescriptor } = context;
    emit({ type: 'stage', stage: 'route' });
    const frame = extracted.frame;
    const references = this.context.resolveReferences(frame, behaviorContext);
    if (!references.ok) return this.finishStreamFallback({ userText, traceId, emit, behaviorContext, evidence: { status: 'rejected', reasonCode: references.reasonCode, semanticIntent: frame.intent, semanticConfidence: frame.confidence }, ...(references.pendingReference === undefined ? {} : { pendingReference: references.pendingReference }), ...(references.candidates === undefined ? {} : { referenceCandidates: references.candidates }) });
    if (behaviorContext.pendingReference !== undefined) await this.context.resetClarification();
    const routeContext = this.context.currentBehaviorContext();
    const route = await this.context.routeFrame(traceId, SESSION_RUN_ID, frame, routeContext, userText, this.context.recentMessages, selectedDescriptor);
    const evidence = buildEvidence(route, frame);
    if (extracted.semanticFallback) evidence.semanticFallback = true;
    if (route.status !== 'matched' || !route.functionId || !route.pluginId) {
      return this.finishStreamFallback({ userText, traceId, emit, behaviorContext: routeContext, evidence, resolvedReferences: references.references });
    }
    emit({ type: 'stage', stage: 'action' });
    const outcome = await this.context.prepareAndExecute({ runId: SESSION_RUN_ID, userText, frame, route, behaviorContext: routeContext });
    return this.finishStreamOutcome({ userText, traceId, emit, evidence, outcome });
  }

  /** 流式生成未命中路由的回复，超限结果不写入历史。
   * 已经透传的增量不能被当成完整答复；done 明确标示失败。
   * @param context - 输入、追踪、事件回调和路由证据
   * @returns 澄清或超限失败结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async finishStreamFallback(context: { userText: string; traceId: string; emit: (event: StreamEvent) => void; behaviorContext: BehaviorContext; evidence: RouteEvidence; resolvedReferences?: ResolvedFactReference[]; pendingReference?: PendingReference; referenceCandidates?: VerifiedFactRecord[] }): Promise<TurnResult> {
    const { userText, traceId, emit, behaviorContext, evidence, resolvedReferences, pendingReference, referenceCandidates } = context;
    if (!(evidence.semanticIntent === 'unknown' && evidence.reasonCode !== 'reference_unresolved' && (behaviorContext.factHistory?.records.length ?? 0) > 0) && !(behaviorContext.pending.status === 'required' && behaviorContext.pending.options?.some((option) => option.key === userText.trim()) === true)) await this.context.markUnresolved(evidence.reasonCode, pendingReference);
    const currentBehaviorContext = this.context.currentBehaviorContext();
    const reply = await trackModelResponseLimit(() => this.context.fallbackReplyStreamed({ traceId, runId: SESSION_RUN_ID, userText, behaviorContext: currentBehaviorContext, recentMessages: this.context.recentMessages, functionDescriptors: this.context.functionDescriptors, reasonCode: evidence.reasonCode, ...(resolvedReferences === undefined ? {} : { resolvedReferences }), ...(referenceCandidates === undefined ? {} : { referenceCandidates }) }, (delta) => emit({ type: 'delta', text: delta }))).catch((error: unknown) => {
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    if (reply === undefined) return { status: 'failed', reply: '模型回复超限，回复未完成。', route: evidence, reasonCode: 'model_response_too_large' };
    this.context.pushMessages(userText, reply);
    return { status: 'clarification', reply, route: evidence, reasonCode: evidence.reasonCode };
  }

  /** 将动作终态转换为流式结果，已执行时继续回复阶段。
   * 待确认及动作拒绝路径不调用回复模型。
   * @param context - 对话上下文及动作结果
   * @returns 本轮结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async finishStreamOutcome(context: { userText: string; traceId: string; emit: (event: StreamEvent) => void; evidence: RouteEvidence; outcome: ExecuteTurnOutcome }): Promise<TurnResult> {
    const { userText, evidence, outcome } = context;
    if (outcome.status === 'awaiting_confirmation') {
      await this.context.resetClarification();
      this.context.pushMessages(userText, outcome.reply);
      return { status: 'awaiting_confirmation', reply: outcome.reply, route: evidence, pending: summarizeAction(outcome.action) };
    }
    if (outcome.status === 'failed' || outcome.status === 'clarification') {
      if (outcome.status === 'clarification') await this.context.markUnresolved(outcome.reasonCode);
      this.context.pushMessages(userText, outcome.reply);
      return { status: outcome.status, reply: outcome.reply, route: evidence, reasonCode: outcome.reasonCode };
    }
    return this.finishStreamExecution({ ...context, outcome });
  }

  /** 已执行动作的回复超限时仍报告动作成功，避免误导重试。
   * 只有完整回复写入最近消息，截断的增量不进入历史。
   * 动作结果仍放在终态中，区分执行成功与回复失败。
   * @param context - 对话上下文及已执行动作
   * @returns 动作成功及回复状态
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  protected async finishStreamExecution(context: { userText: string; traceId: string; emit: (event: StreamEvent) => void; evidence: RouteEvidence; outcome: Extract<ExecuteTurnOutcome, { status: 'executed' }> }): Promise<TurnResult> {
    const { userText, traceId, emit, evidence, outcome } = context;
    await this.context.resetClarification();
    emit({ type: 'stage', stage: 'response' });
    const reply = await trackModelResponseLimit(() => this.context.generateReplyStreamed({ traceId, runId: SESSION_RUN_ID, userText, action: outcome.action, actionResult: outcome.actionResult, behaviorContext: this.context.currentBehaviorContext(), recentMessages: this.context.recentMessages, functionDescriptors: this.context.functionDescriptors }, (delta) => emit({ type: 'delta', text: delta }))).catch((error: unknown) => {
      if (!(error instanceof ModelResponseLimitError)) throw error;
      return undefined;
    });
    if (reply === undefined) return { status: 'executed', reply: '动作已执行，但模型回复超限且不完整，请勿重复执行。', route: evidence, actionResult: outcome.actionResult, reasonCode: 'model_response_too_large' };
    this.context.pushMessages(userText, reply);
    return { status: 'executed', reply, route: evidence, actionResult: outcome.actionResult };
  }


}
