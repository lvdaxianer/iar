import { MAX_CANDIDATE_VERSION_LENGTH, MAX_CLARIFICATION_LABEL_LENGTH, MAX_CLARIFICATION_OPTIONS, type BehaviorContext, type ClarificationState, type PendingInput } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugins';
import type { RouteEvidence } from './session-types.js';

/** 将当前动态 Plugin 描述转换为有限、不具备执行权限的选择状态。 */
export function createSelectionState(descriptors: readonly PluginDescriptor[], unresolvedStreak: number, reasonCode: string): { state: ClarificationState; options: NonNullable<PendingInput['options']> } {
  const selected = descriptors.slice(0, MAX_CLARIFICATION_OPTIONS);
  const candidateKeys = selected.map((descriptor) => descriptor.candidateKey);
  const options = selected.map((descriptor) => ({ key: descriptor.candidateKey, label: descriptor.description.slice(0, MAX_CLARIFICATION_LABEL_LENGTH) }));
  return { state: { mode: 'selection', unresolvedStreak, reasonCode, candidateVersion: candidateKeys.join('|').slice(0, MAX_CANDIDATE_VERSION_LENGTH), candidateKeys }, options };
}

/** 有可信事实的追问交给回复模型处理，不把正常事实回答计入 unresolved。 */
export function hasVerifiedFactsForFollowUp(context: BehaviorContext, evidence: RouteEvidence): boolean {
  return evidence.semanticIntent === 'unknown' && evidence.reasonCode !== 'reference_unresolved' && (context.factHistory?.records.length ?? 0) > 0;
}

/** 用户正在回答已有澄清选项时视为进展，不增加新的 unresolved 次数。 */
export function matchesPendingOption(context: BehaviorContext, userText: string): boolean {
  return context.pending.status === 'required' && context.pending.options?.some((option) => option.key === userText.trim()) === true;
}
