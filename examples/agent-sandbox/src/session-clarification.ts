import { MAX_CANDIDATE_VERSION_LENGTH, MAX_CLARIFICATION_LABEL_LENGTH, MAX_CLARIFICATION_OPTIONS, type BehaviorContext, type ClarificationState, type PendingInput } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import type { SemanticFrame } from '@iar/runtime';
import type { RouteEvidence } from './session-types.js';

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
  reasonCode?: 'function_unavailable' | 'plugin_unavailable';
};

/** 按参数收集优先、稳定路由其次的顺序恢复连续输入目标。 */
export function recoverContinuation(descriptors: readonly PluginDescriptor[], context: BehaviorContext, frame: SemanticFrame, userText: string): ContinuationRecovery {
  const target = context.collection?.kind === 'parameters'
    ? { functionId: context.collection.functionId, pluginId: context.collection.pluginId }
    : GENERIC_CONTINUATION_PATTERN.test(userText) && (context.route.functionId !== undefined || context.route.pluginId !== undefined)
      ? { functionId: context.route.functionId, pluginId: context.route.pluginId }
      : undefined;
  if (target === undefined) return { frame };
  if (target.functionId === undefined || target.pluginId === undefined) return { frame, ...(target.functionId === undefined ? {} : { functionId: target.functionId }), ...(target.pluginId === undefined ? {} : { pluginId: target.pluginId }), reasonCode: target.pluginId === undefined ? 'plugin_unavailable' : 'function_unavailable' };
  const descriptor = findExactDescriptor(descriptors, target.functionId, target.pluginId);
  if (descriptor === undefined) return { frame, functionId: target.functionId, pluginId: target.pluginId, reasonCode: 'plugin_unavailable' };
  return { frame: recoverContinuationFrame(frame, context, descriptor, userText), descriptor, functionId: target.functionId, pluginId: target.pluginId };
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

/** 查找同时匹配 Function 和可选 Plugin 的唯一描述，避免跨实现猜测。 */
function findExactDescriptor(descriptors: readonly PluginDescriptor[], functionId: string | undefined, pluginId: string | undefined): PluginDescriptor | undefined {
  if (!functionId) return undefined;
  const matches = descriptors.filter((descriptor) => descriptor.functionId === functionId && (pluginId === undefined || descriptor.pluginId === pluginId));
  return matches.length === 1 ? matches[0] : undefined;
}

/** 在 descriptor 声明范围内恢复当前轮动作，无法唯一确定时保留 unknown。 */
function recoverAction(frameAction: SemanticFrame['action'], descriptor: PluginDescriptor, context: BehaviorContext, userText: string): SemanticFrame['action'] {
  if (isDeclaredAction(frameAction, descriptor)) return frameAction;
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
