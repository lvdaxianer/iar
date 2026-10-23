import { MAX_CANDIDATE_VERSION_LENGTH, MAX_CLARIFICATION_LABEL_LENGTH, MAX_CLARIFICATION_OPTIONS, type BehaviorContext, type ClarificationState, type PendingInput } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import { classifyWorkflowDecision, projectWorkflowContext, type RouteResult, type SemanticFrame, type WorkflowDecisionDisposition } from '@iar/runtime';
import type { WorkflowDecision } from '@iar/contracts';
import type { RouteEvidence, TurnResult } from './session-types.js';

const GENERIC_CONTINUATION_PATTERN = /(继续|修改|改成|调整|调到|设为|提高|降低|执行这个|按这个|照这个|重试|再试|重新|proceed|retry|change|update|adjust|set|run)/iu;
const UPDATE_CONTINUATION_PATTERN = /(修改|改成|调整|调到|设为|提高|降低|change|update|adjust|set)/iu;
const QUERY_CONTINUATION_PATTERN = /(查询|查一下|现在.*(?:多少|什么)|状态|是多少|query|status|how many)/iu;
const EXECUTE_CONTINUATION_PATTERN = /(继续执行|执行这个|重试|再试|重新执行|proceed|retry|run|execute)/iu;

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
    && (context.factHistory?.records.length ?? 0) > 0
    && (userText.length === 0 || isLikelyFactFollowUp(userText));
}

/** 只有带有明确上下文指代或事实查询词时，才把未知输入视为事实追问。 */
function isLikelyFactFollowUp(userText: string): boolean {
  return /(刚才|之前|上一|上一个|这个|那个|这张|那张|编号|单号|进度|状态|处理到哪|第几个|第几位|多少|哪一个|哪些|记录|回执)/u.test(userText);
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
  return classifyWorkflowDecision(projectWorkflowContext(context).currentState, decision);
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
  const target = context.collection?.kind === 'parameters'
    ? { functionId: context.collection.functionId, pluginId: context.collection.pluginId }
    : (eventAllowsRecovery || (workflowEvent === undefined && GENERIC_CONTINUATION_PATTERN.test(userText))) && (context.route.functionId !== undefined || context.route.pluginId !== undefined)
      ? { functionId: context.route.functionId, pluginId: context.route.pluginId }
      : undefined;
  if (target === undefined) return { frame };
  const matches = findMatchingDescriptors(descriptors, target.functionId, target.pluginId);
  if (matches.length !== 1) return { frame, ...(target.functionId === undefined ? {} : { functionId: target.functionId }), ...(target.pluginId === undefined ? {} : { pluginId: target.pluginId }), ...(matches.length > 1 ? { candidateDescriptors: matches } : {}), reasonCode: resolveRecoveryReason(descriptors, target, matches.length) };
  const descriptor = matches[0];
  if (descriptor === undefined) return { frame, reasonCode: resolveRecoveryReason(descriptors, target, matches.length) };
  return { frame: recoverContinuationFrame(frame, context, descriptor, userText), descriptor, functionId: descriptor.functionId, pluginId: descriptor.pluginId };
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
  if (frameAction !== 'unknown') return isDeclaredAction(frameAction, descriptor) ? frameAction : 'unknown';
  const inferred = inferContinuationAction(userText, descriptor);
  if (inferred !== undefined) return inferred;
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
  const preferred = UPDATE_CONTINUATION_PATTERN.test(userText) ? 'update' : QUERY_CONTINUATION_PATTERN.test(userText) ? 'query' : EXECUTE_CONTINUATION_PATTERN.test(userText) ? 'execute' : undefined;
  return preferred !== undefined && descriptor.actionTypes.includes(preferred) ? preferred : undefined;
}
