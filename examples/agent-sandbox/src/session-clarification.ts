import { MAX_CANDIDATE_VERSION_LENGTH, MAX_CLARIFICATION_LABEL_LENGTH, MAX_CLARIFICATION_OPTIONS, SCHEMA_VERSIONS, type BehaviorContext, type ClarificationState, type PendingInput } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { classifyWorkflowDecision, projectWorkflowContext, type RouteResult, type SemanticFrame, type WorkflowDecisionDisposition } from '@iar/runtime';
import type { WorkflowDecision } from '@iar/contracts';
import type { RouteEvidence, TurnResult } from './session-types.js';

const GENERIC_CONTINUATION_PATTERN = /(?:^(?:那|那么|接着|接下来|另外|此外|上述|这|这个|那个)|继续|修改|改成|调整|调到|设为|提高|降低|上调|下调|往上调|往下调|增加|减少|加上|减去|执行这个|按这个|照这个|重试|再试|重新|proceed|retry|change|update|adjust|increase|decrease|set|run)/iu;
const UPDATE_CONTINUATION_PATTERN = /(修改|改成|调整|调到|设为|提高|降低|上调|下调|往上调|往下调|增加|减少|加上|减去|change|update|adjust|increase|decrease|set)/iu;
const QUERY_CONTINUATION_PATTERN = /(查询|查一下|现在.*(?:多少|什么)|状态|结果|成功了吗|生效了吗|跑完了吗|有没有完成|怎么样|是多少|query|status|how many)/iu;
const INFORMATIONAL_QUERY_PATTERN = /(怎么|如何|流程|方式|方法|能不能|是否可以|为什么|什么是|how to|can i|why)/iu;
const EXECUTE_CONTINUATION_PATTERN = /(继续执行|执行这个|重试|再试|重跑|再跑|重新跑|重新执行|proceed|retry|run|execute)/iu;
const EXPLICIT_SIDE_EFFECT_PATTERN = /(创建|新增|修改|改成|调整|调到|设为|删除|重跑|导出|申请|执行|重试|create|update|change|adjust|delete|export|apply|execute|retry)/iu;
const EXPLICIT_NEW_TOPIC_PATTERN = /(换个话题|换一个话题|开始新的话题|另起一个话题|new topic|different topic)/iu;
const EXPLICIT_CANCEL_PATTERN = /(取消|算了|不用了|放弃|不做了|cancel|stop|abort)/iu;
const CONFIRMATION_ONLY_PATTERN = /^(?:直接)?(?:确认|同意|批准|confirm|approve)(?:上一个|当前|这个)?(?:操作|动作)?$/iu;
const DISCOURSE_CONTINUATION_PATTERN = /^(?:那|那么|接着|接下来|另外|此外|上述|这|这个|那个)/u;
const RELATIVE_LIST_QUERY_PATTERN = /(?:第\s*(?:[一二三四五六七八九十百\d]+)\s*(?:个|条|项|位)|最后一个|失败的那个|成功的那个|这个(?:条目|记录)?|那个(?:条目|记录)?)/u;
const MULTI_INTENT_PATTERN = /(顺便|同时|另外|以及|并且|再加上|and|also|as well)/iu;

/**
 * 判断输入是否为不带新副作用目标的明确取消语句。
 *
 * @param userText - 当前用户输入
 * @returns 是否可以穿过 Bridge pending 门禁进入取消判定
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
export function isExplicitStandaloneCancellation(userText: string): boolean {
  return EXPLICIT_CANCEL_PATTERN.test(userText) && !EXPLICIT_SIDE_EFFECT_PATTERN.test(userText);
}

/** 将当前动态 Plugin 描述转换为有限、不具备执行权限的选择状态。 */
export function createSelectionState(descriptors: readonly PluginDescriptor[], unresolvedStreak: number, reasonCode: string): { state: ClarificationState; options: NonNullable<PendingInput['options']> } {
  const selected = descriptors.slice(0, MAX_CLARIFICATION_OPTIONS);
  const candidateKeys = selected.map((descriptor) => descriptor.candidateKey);
  const options = selected.map((descriptor) => ({ key: descriptor.candidateKey, label: descriptor.description.slice(0, MAX_CLARIFICATION_LABEL_LENGTH) }));
  return { state: { mode: 'selection', unresolvedStreak, reasonCode, candidateVersion: candidateKeys.join('|').slice(0, MAX_CANDIDATE_VERSION_LENGTH), candidateKeys }, options };
}

/** 有可信事实的追问交给回复模型处理，不把正常事实回答计入 unresolved。 */
export function hasVerifiedFactsForFollowUp(context: BehaviorContext, evidence: RouteEvidence, userText = ''): boolean {
  return evidence.semanticIntent === 'unknown'
    && evidence.reasonCode !== 'reference_unresolved'
    && ((context.factHistory?.records.length ?? 0) > 0 || hasCancelledConversationTurn(context, userText))
    && (userText.length === 0 || isLikelyFactFollowUp(context, userText));
}

/** 将有可信事实依据的查询归一化为上下文回答，避免模型事件阻断只读追问。 */
export function normalizeContextFollowUpFrame(context: BehaviorContext, frame: SemanticFrame, userText: string): SemanticFrame {
  if (!isContextFollowUpCandidate(context, frame, userText)) return frame;
  const references = frame.references.length > 0
    ? frame.references
    : [{ text: userText, relation: 'current' as const, scope: 'same_fact_chain' as const }];
  const normalized = {
    ...frame,
    schemaVersion: 'iar.semantic-frame/v2' as const,
    intent: 'unknown' as const,
    action: 'query' as const,
    references,
    workflowDecision: {
      schemaVersion: SCHEMA_VERSIONS.workflowDecision,
      userIntent: 'answer_context' as const,
      event: 'context_answered' as const
    }
  };
  delete normalized.pluginId;
  return normalized;
}

/**
 * 丢弃模型把上一轮新话题事件错误延续到当前明确业务请求，并补齐明确取消语句。
 *
 * @param frame - 当前模型抽取的语义帧
 * @param userText - 当前用户输入
 * @returns 经过当前文本边界校验后的工作流事件
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
export function normalizeCurrentTurnWorkflowDecision(frame: SemanticFrame, userText: string): SemanticFrame['workflowDecision'] {
  const decision = frame.workflowDecision;
  const explicitCancellation = isExplicitStandaloneCancellation(userText);
  if (explicitCancellation) return {
    schemaVersion: SCHEMA_VERSIONS.workflowDecision,
    userIntent: 'cancel_workflow',
    event: 'workflow_cancelled'
  };
  if (decision === undefined) return undefined;
  // 确认接口已经单独完成上一轮确认；下一条普通问题不能被模型重复携带的
  // confirmation_accepted/rejected 事件阻断，应重新按当前用户问题路由。
  if (decision.event === 'confirmation_accepted' || decision.event === 'confirmation_rejected') return undefined;
  if (decision.event === 'new_topic' && EXPLICIT_NEW_TOPIC_PATTERN.test(userText)) return decision;
  if (decision.event === 'workflow_cancelled' && EXPLICIT_CANCEL_PATTERN.test(userText)) return decision;
  return undefined;
}

/** 只有带有明确上下文指代或事实查询词时，才把未知输入视为事实追问。 */
function isLikelyFactFollowUp(context: BehaviorContext, userText: string): boolean {
  if (/(刚才|之前|上一|上一个|这个|那个|这张|那张|编号|单号|进度|状态|结果|处理到哪|第几个|第几位|第\s*(?:[一二三四五六七八九十百\d]+)\s*(?:个|条|项|位)|最后一个|失败的那个|成功的那个|多少|哪一个|哪些|记录|回执|持续多久|开始时间|级别|等级)/u.test(userText)) return true;
  return (context.factHistory?.records ?? []).some((record) => Object.values(record.values).some((value) => typeof value === 'string' && value.length > 0 && userText.includes(value)));
}

/** 只把有历史指代且没有副作用动作的当前输入视为事实追问候选。 */
function isContextFollowUpCandidate(context: BehaviorContext, frame: SemanticFrame, userText: string): boolean {
  return ((context.factHistory?.records.length ?? 0) > 0 || hasCancelledConversationTurn(context, userText))
    && (frame.action === 'query' || frame.action === 'unknown' || QUERY_CONTINUATION_PATTERN.test(userText))
    && !CONFIRMATION_ONLY_PATTERN.test(userText.trim())
    && (!EXPLICIT_SIDE_EFFECT_PATTERN.test(userText) || QUERY_CONTINUATION_PATTERN.test(userText))
    && isLikelyFactFollowUp(context, userText);
}

/**
 * 判断当前输入是否可追问最近已取消的会话轮次。
 *
 * @param context - 当前结构化会话上下文
 * @param userText - 当前用户输入
 * @returns 是否存在可追问的取消状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function hasCancelledConversationTurn(context: BehaviorContext, userText: string): boolean {
  return (context.conversationTurns?.turns ?? []).some((turn) => turn.outcome === 'cancelled')
    && (userText.length === 0 || isLikelyFactFollowUp(context, userText));
}

/** 用户正在回答已有澄清选项时视为进展，不增加新的 unresolved 次数。 */
export function matchesPendingOption(context: BehaviorContext, userText: string): boolean {
  return context.pending.status === 'required' && context.pending.options?.some((option) => option.key === userText.trim()) === true;
}

export type ContinuationRecovery = {
  frame: SemanticFrame;
  descriptor?: PluginDescriptor;
  functionId?: string;
  pluginId?: string;
  candidateDescriptors?: PluginDescriptor[];
  reasonCode?: ContinuationRecoveryReasonCode;
};

/** 将“如何做”类询问固定为只读语义，并丢弃模型附带的副作用 operation。 */
export function normalizeInformationalQueryFrame(frame: SemanticFrame, userText: string): SemanticFrame {
  if (!INFORMATIONAL_QUERY_PATTERN.test(userText)) return frame;
  const slots = { ...frame.slots };
  delete slots.operation;
  return { ...frame, action: 'query', slots };
}

export type ContinuationRecoveryReasonCode = 'function_unavailable' | 'plugin_unavailable' | 'function_ambiguous' | 'plugin_ambiguous';

/** 将恢复后的多候选目标统一转换为可选择澄清，供普通与流式入口复用。
 * @param input - 当前输入、恢复结果、路由证据和候选收集器
 * @returns 候选收集器生成的澄清结果；无候选时返回 undefined
 * @author lvdaxianerplus
 * @date 2026-10-24
 */
export async function recoverFunctionCandidates(input: { userText: string; recovery: ContinuationRecovery; frame: SemanticFrame; evidence: RouteEvidence; collect: (context: { userText: string; route: RouteResult; frame: SemanticFrame; evidence: RouteEvidence }) => Promise<{ result?: TurnResult }> }): Promise<TurnResult | undefined> {
  const { recovery } = input;
  if (recovery.candidateDescriptors === undefined || recovery.reasonCode === undefined) return undefined;
  const evidence = { ...input.evidence, status: 'clarification' };
  const candidates = await input.collect({ userText: input.userText, route: { status: 'needs_clarification', reasonCode: recovery.reasonCode, ...(recovery.functionId === undefined ? {} : { functionId: recovery.functionId }), ...(recovery.pluginId === undefined ? {} : { pluginId: recovery.pluginId }) }, frame: input.frame, evidence });
  return candidates.result;
}

/** 让普通与流式入口共享同一套模型事件校验和取消分类。 */
export function classifySessionWorkflowDecision(context: BehaviorContext, decision: WorkflowDecision | undefined): WorkflowDecisionDisposition {
  const projection = projectWorkflowContext(context);
  return classifyWorkflowDecision(projection.outcome === 'none' ? projection.activeState : projection.currentState, decision);
}

/** 将受控的取消或非法转换映射为稳定、无业务标识的用户反馈。 */
export function workflowDecisionReply(disposition: WorkflowDecisionDisposition): string | undefined {
  if (disposition.kind === 'cancelled') return disposition.event === 'new_topic' ? '已结束当前流程，接下来可以开始新的话题。' : '已取消当前流程，未执行任何动作。';
  if (disposition.kind === 'invalid') return '当前工作流事件与会话状态不匹配，本轮未执行任何动作。';
  return undefined;
}

/** 按参数收集优先、稳定路由其次的顺序恢复连续输入目标。 */
export function recoverContinuation(descriptors: readonly PluginDescriptor[], context: BehaviorContext, frame: SemanticFrame, userText: string): ContinuationRecovery {
  const workflowEvent = frame.workflowDecision?.event;
  const eventAllowsRecovery = workflowEvent === 'parameter_received' || workflowEvent === 'function_selected';
  const hasParameterCollection = context.collection?.kind === 'parameters';
  if (!hasParameterCollection && context.pending.status !== 'required' && CONFIRMATION_ONLY_PATTERN.test(userText.trim())) {
    return { frame: clearUntrustedContinuationTarget(frame) };
  }
  const hasStableRoute = context.route.functionId !== undefined || context.route.pluginId !== undefined;
  if (INFORMATIONAL_QUERY_PATTERN.test(userText) && !hasStableRoute) {
    const candidates = findSharedDescriptorCandidates(descriptors, userText);
    if (candidates.length > 1) return { frame: clearUntrustedContinuationTarget(frame), candidateDescriptors: candidates, reasonCode: 'function_ambiguous' };
  }
  if (INFORMATIONAL_QUERY_PATTERN.test(userText) && !hasStableRoute && !CONFIRMATION_ONLY_PATTERN.test(userText.trim())) {
    return { frame: { ...frame, action: 'query' } };
  }
  if (isStaleRouteWithoutCurrentEvidence(descriptors, context, frame, userText)) {
    return { frame: clearUntrustedContinuationTarget(frame) };
  }
  const target = context.collection?.kind === 'parameters'
    ? { functionId: context.collection.functionId, pluginId: context.collection.pluginId }
    : (eventAllowsRecovery || (workflowEvent === undefined && ((GENERIC_CONTINUATION_PATTERN.test(userText) && !RELATIVE_LIST_QUERY_PATTERN.test(userText)) || hasTrustedQueryContinuationEvidence(descriptors, context, frame, userText) || EXECUTE_CONTINUATION_PATTERN.test(userText)))) && (context.route.functionId !== undefined || context.route.pluginId !== undefined)
      ? { functionId: context.route.functionId, pluginId: context.route.pluginId }
      : undefined;
  if (target === undefined) {
    const candidates = MULTI_INTENT_PATTERN.test(userText) ? findAmbiguousTextDescriptors(descriptors, userText) : [];
    return candidates.length > 1 ? { frame: clearUntrustedContinuationTarget(frame), candidateDescriptors: candidates, reasonCode: 'function_ambiguous' } : { frame };
  }
  if (!hasParameterCollection && hasAmbiguousTextDescriptorEvidence(descriptors, userText)) {
    return { frame: clearUntrustedContinuationTarget(frame) };
  }
  const stableMatches = findMatchingDescriptors(descriptors, target.functionId, target.pluginId);
  const canPreferDiscourseRoute = !hasParameterCollection
    && DISCOURSE_CONTINUATION_PATTERN.test(userText)
    && (frame.action === 'query' || (frame.action === 'unknown' && !EXPLICIT_SIDE_EFFECT_PATTERN.test(userText)))
    && stableMatches.length === 1
    && stableMatches[0] !== undefined;
  if (canPreferDiscourseRoute) {
    const descriptor = stableMatches[0]!;
    return { frame: recoverContinuationFrame(frame, context, descriptor, userText), descriptor, functionId: descriptor.functionId, pluginId: descriptor.pluginId };
  }
  // Direct callers may provide the pre-normalization frame used by the workflow
  // recovery contract. Runtime turns normalize trusted fact follow-ups to
  // intent=unknown before reaching this point, so this branch only preserves
  // the verified route for the already-classified relative query shape.
  if (!hasParameterCollection && frame.intent !== 'unknown' && frame.action === 'query' && RELATIVE_LIST_QUERY_PATTERN.test(userText) && stableMatches.length === 1 && stableMatches[0] !== undefined) {
    const descriptor = stableMatches[0]!;
    return { frame: recoverContinuationFrame(frame, context, descriptor, userText), descriptor, functionId: descriptor.functionId, pluginId: descriptor.pluginId };
  }
  const currentFrame = hasParameterCollection ? frame : normalizeAuthorizedFrame(descriptors, frame, userText, target.functionId);
  if (!hasParameterCollection && frame.intent === 'unknown') {
    const textCandidate = chooseTextDescriptor(descriptors, userText, frame.action);
    if (textCandidate !== undefined && textCandidate.functionId !== target.functionId) {
      return { frame: { ...currentFrame, intent: textCandidate.functionId, pluginId: textCandidate.pluginId } };
    }
  }
  const currentFunctionIsAuthorized = currentFrame.intent !== 'unknown'
    && descriptors.some((descriptor) => descriptor.functionId === currentFrame.intent && (currentFrame.pluginId === undefined || descriptor.pluginId === currentFrame.pluginId));
  if (!hasParameterCollection && currentFunctionIsAuthorized && (target.functionId === undefined || currentFrame.intent !== target.functionId)) return { frame: currentFrame };
  if (!hasParameterCollection && currentFunctionIsAuthorized && stableMatches.length === 1 && stableMatches[0] !== undefined) {
    const requestedAction = inferRequestedContinuationAction(userText);
    if (requestedAction !== undefined && !stableMatches[0].actionTypes.includes(requestedAction)) return { frame: clearUntrustedContinuationTarget(currentFrame) };
    return { frame: recoverContinuationFrame(currentFrame, context, stableMatches[0], userText), descriptor: stableMatches[0], functionId: stableMatches[0].functionId, pluginId: stableMatches[0].pluginId };
  }
  const matches = findMatchingDescriptors(descriptors, target.functionId, target.pluginId);
  if (matches.length !== 1) return { frame: currentFrame, ...(target.functionId === undefined ? {} : { functionId: target.functionId }), ...(target.pluginId === undefined ? {} : { pluginId: target.pluginId }), ...(matches.length > 1 ? { candidateDescriptors: matches } : {}), reasonCode: resolveRecoveryReason(descriptors, target, matches.length) };
  const descriptor = matches[0];
  if (descriptor === undefined) return { frame: currentFrame, reasonCode: resolveRecoveryReason(descriptors, target, matches.length) };
  const requestedAction = inferRequestedContinuationAction(userText);
  if (requestedAction !== undefined && !descriptor.actionTypes.includes(requestedAction)) {
    return { frame: clearUntrustedContinuationTarget(currentFrame) };
  }
  return { frame: recoverContinuationFrame(currentFrame, context, descriptor, userText), descriptor, functionId: descriptor.functionId, pluginId: descriptor.pluginId };
}

/** 判断模型是否把上一目标带入了当前无对象、无指代的新查询。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function isStaleRouteWithoutCurrentEvidence(descriptors: readonly PluginDescriptor[], context: BehaviorContext, frame: SemanticFrame, userText: string): boolean {
  const previousFunctionId = context.route.functionId;
  if (previousFunctionId === undefined || frame.intent !== previousFunctionId) return false;
  if (!isBareQueryRequest(userText)) return false;
  if (frame.references.length > 0 || GENERIC_CONTINUATION_PATTERN.test(userText) || isLikelyFactFollowUp(context, userText)) return false;
  if (EXPLICIT_SIDE_EFFECT_PATTERN.test(userText)) return false;
  return chooseTextDescriptor(descriptors, userText, frame.action)?.functionId !== previousFunctionId;
}

/** 判断当前查询是否有足够证据继续使用同一稳定路由。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function hasTrustedQueryContinuationEvidence(descriptors: readonly PluginDescriptor[], context: BehaviorContext, frame: SemanticFrame, userText: string): boolean {
  if (!QUERY_CONTINUATION_PATTERN.test(userText)) return false;
  if (isBareQueryRequest(userText)) return false;
  if (frame.references.length > 0 || isLikelyFactFollowUp(context, userText)) return true;
  const currentDescriptor = chooseTextDescriptor(descriptors, userText, frame.action);
  return currentDescriptor !== undefined
    && (currentDescriptor.functionId === context.route.functionId || currentDescriptor.pluginId === context.route.pluginId);
}

/** 判断输入是否只有泛化查询动作而没有查询对象。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function isBareQueryRequest(userText: string): boolean {
  return /^(?:可以|能否|能不能|请|麻烦)?(?:帮我)?(?:查询|查一下|查下|查查)(?:一下|下)?(?:吧|吗|呢)?[\s。！？!?]*$/iu.test(userText.trim());
}

/**
 * 将已有 descriptor 绑定到当前语义帧，并只恢复声明过的动作类型。
 *
 * @param frame - 模型抽取的语义帧
 * @param context - 当前行为上下文
 * @param descriptor - 已验证的 Function descriptor
 * @param userText - 当前用户输入
 * @returns 绑定稳定 Function/Plugin 标识后的语义帧
 */
export function recoverContinuationFrame(frame: SemanticFrame, context: BehaviorContext, descriptor: PluginDescriptor | undefined, userText: string): SemanticFrame {
  if (descriptor === undefined) return frame;
  return { ...frame, intent: descriptor.functionId, pluginId: descriptor.pluginId, action: recoverAction(frame.action, descriptor, context, userText) };
}

/** 当前轮动作与旧 descriptor 不兼容时，清除不可信的旧目标，避免污染新请求。 */
function clearUntrustedContinuationTarget(frame: SemanticFrame): SemanticFrame {
  const cleared = { ...frame, intent: 'unknown' as const, action: 'unknown' as const };
  delete cleared.pluginId;
  return cleared;
}

/** 仅把模型输出的唯一、可验证标识别名归一到授权 descriptor，不创建新标识。 */
function normalizeAuthorizedFrame(descriptors: readonly PluginDescriptor[], frame: SemanticFrame, userText: string, previousFunctionId: string | undefined): SemanticFrame {
  if (frame.intent === 'unknown') return frame;
  const exact = descriptors.filter((descriptor) => descriptor.functionId === frame.intent && (frame.pluginId === undefined || descriptor.pluginId === frame.pluginId));
  if (exact.length === 1 && exact[0] !== undefined) {
    const textCandidate = chooseTextDescriptor(descriptors, userText, frame.action);
    if (textCandidate !== undefined && textCandidate.functionId !== exact[0].functionId && exact[0].functionId === previousFunctionId) return { ...frame, intent: textCandidate.functionId, pluginId: textCandidate.pluginId };
    return { ...frame, intent: exact[0].functionId, pluginId: exact[0].pluginId };
  }
  const candidates = descriptors.filter((descriptor) => (frame.action === 'unknown' || descriptor.actionTypes.includes(frame.action as PluginDescriptor['actionTypes'][number])) && identifierOverlap(frame.intent, descriptor.functionId) > 0);
  const textCandidate = chooseTextDescriptor(descriptors, userText, frame.action);
  if (candidates.length === 0) return textCandidate === undefined ? frame : { ...frame, intent: textCandidate.functionId, pluginId: textCandidate.pluginId };
  const scores = candidates.map((descriptor) => ({ descriptor, score: identifierOverlap(frame.intent, descriptor.functionId) }));
  const bestScore = Math.max(...scores.map((item) => item.score));
  const best = scores.filter((item) => item.score === bestScore);
  if (best.length !== 1 || best[0] === undefined) return frame;
  return { ...frame, intent: best[0].descriptor.functionId, pluginId: best[0].descriptor.pluginId };
}

/** 用当前输入和动态 descriptor 描述做唯一匹配；常见描述词由运行时按文档频率自动降权。 */
function chooseTextDescriptor(descriptors: readonly PluginDescriptor[], userText: string, action: SemanticFrame['action']): PluginDescriptor | undefined {
  const scored = scoreTextDescriptors(descriptors, userText, action);
  const first = scored[0];
  const second = scored[1];
  if (first === undefined || first.score < 2 || (second !== undefined && second.score === first.score)) return undefined;
  return first.descriptor;
}

/** 当前轮同时命中多个授权 descriptor 时，阻止历史稳定路由兜底。 */
function hasAmbiguousTextDescriptorEvidence(descriptors: readonly PluginDescriptor[], userText: string): boolean {
  const scored = findAmbiguousTextDescriptors(descriptors, userText);
  return scored.length > 1;
}

/** 返回当前轮同时命中的多个授权 descriptor，供澄清而不是合并执行。 */
function findAmbiguousTextDescriptors(descriptors: readonly PluginDescriptor[], userText: string): PluginDescriptor[] {
  const scored = scoreTextDescriptors(descriptors, userText, 'unknown');
  const first = scored[0];
  const second = scored[1];
  return first !== undefined && second !== undefined && first.score >= 2 && second.score >= 2 && second.score * 2 >= first.score
    ? scored.slice(0, MAX_CLARIFICATION_OPTIONS).map((item) => item.descriptor)
    : [];
}

/** 对仅凭共享自然语言名词无法区分的咨询请求返回候选，禁止凭单个动作词抢路由。 */
function findSharedDescriptorCandidates(descriptors: readonly PluginDescriptor[], userText: string): PluginDescriptor[] {
  const normalizedText = normalizeLexicalText(userText);
  if (normalizedText.length < 2) return [];
  const features = descriptors.map((descriptor) => descriptorFeatures(descriptor));
  const frequency = new Map<string, number>();
  for (const set of features) for (const feature of set) frequency.set(feature, (frequency.get(feature) ?? 0) + 1);
  const shared = new Set([...frequency.entries()].filter(([feature, count]) => count > 1 && feature.length >= 2 && normalizedText.includes(feature)).map(([feature]) => feature));
  if (shared.size === 0) return [];
  return descriptors.filter((_descriptor, index) => [...(features[index] ?? [])].some((feature) => shared.has(feature))).slice(0, MAX_CLARIFICATION_OPTIONS);
}

/** 计算当前文本对授权 descriptor 的闭集证据分数。 */
function scoreTextDescriptors(descriptors: readonly PluginDescriptor[], userText: string, action: SemanticFrame['action']): Array<{ descriptor: PluginDescriptor; score: number }> {
  const normalizedText = normalizeLexicalText(userText);
  if (normalizedText.length < 2) return [];
  const features = descriptors.map((descriptor) => descriptorFeatures(descriptor));
  const frequency = new Map<string, number>();
  for (const set of features) for (const feature of set) frequency.set(feature, (frequency.get(feature) ?? 0) + 1);
  return descriptors.map((descriptor, index) => {
    const descriptorFeaturesSet = features[index] ?? new Set<string>();
    const score = [...descriptorFeaturesSet].reduce((total, feature) => frequency.get(feature) === 1 && normalizedText.includes(feature) ? total + feature.length : total, 0);
    const actionCompatible = action === 'unknown' || descriptor.actionTypes.includes(action as PluginDescriptor['actionTypes'][number]);
    return { descriptor, score: actionCompatible ? score : 0 };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
}

/** 提取中英文标识和中文二元片段，完全由 descriptor 内容驱动。 */
function descriptorFeatures(descriptor: PluginDescriptor): Set<string> {
  return new Set([...identifierFeatures(descriptor.functionId), ...identifierFeatures(descriptor.description ?? '')]);
}

function identifierFeatures(value: string): string[] {
  const latinFeatures = value.toLocaleLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const normalized = normalizeLexicalText(value);
  const result: string[] = [...latinFeatures];
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const pair = normalized.slice(index, index + 2);
    if (/[^a-z0-9]/u.test(pair)) result.push(pair);
  }
  return result;
}

function normalizeLexicalText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, '').replace(/[，。！？、；：（）()「」“”‘’"'`~·…!?;,.:/\\-]/gu, '');
}

/** 标识片段只用于闭集内的唯一归一化，不能单独产生可执行目标。 */
function identifierOverlap(left: string, right: string): number {
  const leftParts = new Set(left.split(/[._:-]+/u).filter((part) => part.length > 1));
  return right.split(/[._:-]+/u).filter((part) => leftParts.has(part)).length;
}

/** 查找匹配已验证目标的当前授权描述。 */
function findMatchingDescriptors(descriptors: readonly PluginDescriptor[], functionId: string | undefined, pluginId: string | undefined): PluginDescriptor[] {
  return descriptors.filter((descriptor) => (functionId === undefined || descriptor.functionId === functionId) && (pluginId === undefined || descriptor.pluginId === pluginId));
}

/** 将零个或多个匹配归一化为稳定的不可执行原因。 */
function resolveRecoveryReason(descriptors: readonly PluginDescriptor[], target: { functionId: string | undefined; pluginId: string | undefined }, matchCount: number): ContinuationRecoveryReasonCode {
  if (matchCount > 1) return target.functionId === undefined ? 'function_ambiguous' : 'plugin_ambiguous';
  if (target.pluginId !== undefined) return 'plugin_unavailable';
  if (target.functionId === undefined) return 'function_unavailable';
  return descriptors.some((descriptor) => descriptor.functionId === target.functionId) ? 'plugin_unavailable' : 'function_unavailable';
}

/** 在 descriptor 声明范围内恢复当前轮动作，无法唯一确定时保留 unknown。 */
function recoverAction(frameAction: SemanticFrame['action'], descriptor: PluginDescriptor, context: BehaviorContext, userText: string): SemanticFrame['action'] {
  const inferred = inferContinuationAction(userText, descriptor);
  if (inferred !== undefined) return inferred;
  if (frameAction !== 'unknown') return isDeclaredAction(frameAction, descriptor) ? frameAction : 'unknown';
  const operation = context.collection?.kind === 'parameters' ? context.collection.collected.operation : context.slots.operation?.value;
  if (typeof operation === 'string') {
    const operationKind = descriptor.operationMetadata.operations.find((item) => item.name === operation)?.kind;
    const actionTypes = descriptor.actionTypes.filter((action) => operationKind === 'read' ? action === 'query' : operationKind === 'action' ? action !== 'query' : false);
    const actionType = actionTypes.length === 1 ? actionTypes[0] : undefined;
    if (actionType !== undefined) return actionType;
  }
  const actionType = descriptor.actionTypes.length === 1 ? descriptor.actionTypes[0] : undefined;
  return actionType ?? 'unknown';
}

/** 只接受当前 Function 已声明的动作类型。 */
function isDeclaredAction(action: SemanticFrame['action'], descriptor: PluginDescriptor): boolean {
  return action !== 'unknown' && descriptor.actionTypes.includes(action as PluginDescriptor['actionTypes'][number]);
}

/** 从通用连续词推断动作，不读取或匹配任何业务名称。 */
function inferContinuationAction(userText: string, descriptor: PluginDescriptor): SemanticFrame['action'] | undefined {
  const preferred = inferRequestedContinuationAction(userText);
  return preferred !== undefined && descriptor.actionTypes.includes(preferred) ? preferred : undefined;
}

/** 从当前输入推断用户明确要求的动作，不受旧 descriptor 支持范围影响。 */
function inferRequestedContinuationAction(userText: string): Exclude<SemanticFrame['action'], 'unknown'> | undefined {
  return UPDATE_CONTINUATION_PATTERN.test(userText) ? 'update' : QUERY_CONTINUATION_PATTERN.test(userText) ? 'query' : EXECUTE_CONTINUATION_PATTERN.test(userText) ? 'execute' : undefined;
}
