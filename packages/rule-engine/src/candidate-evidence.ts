/**
 * 聚合候选证据、排序冲突和稳定结果。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type {
  ExcludedCandidateEvidence,
  MatchedRuleEvidence,
  RuleCandidateEvidence,
  RuleEvaluationResult
} from './types.js';

/**
 * 将同一候选的多条命中规则聚合为一个候选。
 *
 * @param matchedRules - 所有命中证据
 * @returns 稳定排序的候选列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function aggregateCandidates(matchedRules: readonly MatchedRuleEvidence[]): RuleCandidateEvidence[] {
  const grouped = new Map<string, MatchedRuleEvidence[]>();
  matchedRules.forEach((evidence) => {
    const current = grouped.get(evidence.candidateId) ?? [];
    grouped.set(evidence.candidateId, [...current, evidence]);
  });
  return [...grouped.entries()]
    .map(([candidateId, evidence]) => toCandidateEvidence(candidateId, evidence))
    .sort(compareCandidates);
}

/**
 * 将同一候选的槽位、风险和证据合并。
 *
 * @param candidateId - 候选标识
 * @param evidence - 候选命中规则
 * @returns 聚合候选
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toCandidateEvidence(candidateId: string, evidence: readonly MatchedRuleEvidence[]): RuleCandidateEvidence {
  const ordered = [...evidence].sort(compareEvidence);
  const primary = ordered[0];
  // 聚合入口理论上总有一条证据，异常输入必须 fail-closed。
  if (!primary) throw new Error('规则命中证据不能为空');
  const base: RuleCandidateEvidence = {
    candidateId,
    priority: primary.priority,
    specificity: primary.specificity,
    requiredSlots: uniqueStrings(ordered.flatMap((item) => item.requiredSlots)),
    evidenceCodes: uniqueStrings(ordered.flatMap((item) => item.evidenceCodes)),
    matchedRuleIds: ordered.map((item) => item.ruleId)
  };
  // 风险必须按最高等级聚合，禁止低风险规则覆盖高风险声明。
  const riskLevel = highestRisk(ordered.map((item) => item.riskLevel));
  // 未声明风险时保留基础候选，不伪造默认等级。
  const withRisk = riskLevel === undefined ? base : { ...base, riskLevel };
  const requiresConfirmation = ordered.some((item) => item.requiresConfirmation === true);
  // 没有确认要求时直接返回聚合结果。
  if (!requiresConfirmation) return withRisk;
  return { ...withRisk, requiresConfirmation: true };
}

/**
 * 解析最高等级候选并保留冲突证据。
 *
 * @param candidates - 已排序候选
 * @param matchedRules - 命中证据
 * @param exclusions - 排除证据
 * @returns 最终结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function resolveCandidates(
  candidates: readonly RuleCandidateEvidence[],
  matchedRules: readonly MatchedRuleEvidence[],
  exclusions: readonly ExcludedCandidateEvidence[]
): RuleEvaluationResult {
  // 没有任何命中候选时返回 no_match 或 rejected。
  if (candidates.length === 0) return emptyResult(matchedRules, exclusions);
  const first = candidates[0];
  // 防御性处理稀疏数组，避免读取不存在的最高候选。
  if (!first) return emptyResult(matchedRules, exclusions);
  // 先按排序等级分区，再统一追加较低候选的解释证据。
  const partition = partitionCandidates(candidates, first);
  const withLowerEvidence = appendLowerPriorityExclusions(exclusions, partition.lower);
  // 同等级候选必须进入澄清，禁止静默猜测执行目标。
  if (partition.top.length > 1) return clarificationResult(partition.top, matchedRules, withLowerEvidence);
  return selectedResult(partition.top, matchedRules, withLowerEvidence);
}

/**
 * 按最高排序等级拆分候选。
 *
 * @param candidates - 已排序候选
 * @param first - 最高等级候选
 * @returns 最高等级和较低等级候选
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function partitionCandidates(candidates: readonly RuleCandidateEvidence[], first: RuleCandidateEvidence): { top: RuleCandidateEvidence[]; lower: RuleCandidateEvidence[] } {
  return candidates.reduce<{ top: RuleCandidateEvidence[]; lower: RuleCandidateEvidence[] }>((partition, candidate) => {
    const target = sameRank(candidate, first) ? partition.top : partition.lower;
    target.push(candidate);
    return partition;
  }, { top: [], lower: [] });
}

/**
 * 创建唯一最高候选结果。
 *
 * @param candidates - 最高等级候选
 * @param matchedRules - 命中证据
 * @param exclusions - 排除证据
 * @returns 命中或空结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function selectedResult(candidates: readonly RuleCandidateEvidence[], matchedRules: readonly MatchedRuleEvidence[], exclusions: readonly ExcludedCandidateEvidence[]): RuleEvaluationResult {
  const selected = candidates[0];
  // 分区结果为空时不能伪造 selectedCandidateId。
  if (!selected) return emptyResult(matchedRules, exclusions);
  return { status: 'matched', selectedCandidateId: selected.candidateId, candidates, matchedRules, excludedCandidates: exclusions, conflicts: [] };
}

/**
 * 创建空候选结果。
 *
 * @param matchedRules - 命中证据
 * @param exclusions - 排除证据
 * @returns 无匹配或拒绝结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function emptyResult(matchedRules: readonly MatchedRuleEvidence[], exclusions: readonly ExcludedCandidateEvidence[]): RuleEvaluationResult {
  const rejected = exclusions.some((item) => item.reasonCode === 'unknown_field_rejected' || item.reasonCode === 'invalid_rule');
  // 只有明确拒绝证据才升级为空结果的 rejected 状态。
  return {
    status: rejected ? 'rejected' : 'no_match',
    candidates: [],
    matchedRules,
    excludedCandidates: exclusions,
    conflicts: []
  };
}

/**
 * 创建需要澄清的并列结果。
 *
 * @param candidates - 最高等级候选
 * @param matchedRules - 命中证据
 * @param exclusions - 排除证据
 * @returns 澄清结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function clarificationResult(
  candidates: readonly RuleCandidateEvidence[],
  matchedRules: readonly MatchedRuleEvidence[],
  exclusions: readonly ExcludedCandidateEvidence[]
): RuleEvaluationResult {
  const first = candidates[0];
  // 冲突候选为空时退回统一空结果构造器。
  if (!first) return emptyResult(matchedRules, exclusions);
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  const ruleIds = matchedRules
    .filter((evidence) => candidateIds.includes(evidence.candidateId) && sameRank(evidence, first))
    .map((evidence) => evidence.ruleId);
  return {
    status: 'needs_clarification',
    candidates,
    matchedRules,
    excludedCandidates: exclusions,
    conflicts: [{ candidateIds, priority: first.priority, specificity: first.specificity, ruleIds, reasonCode: 'equal_priority_and_specificity' }]
  };
}

/**
 * 为较低等级候选追加排除证据。
 *
 * @param exclusions - 原有排除证据
 * @param lowerCandidates - 较低等级候选
 * @returns 扩展后的排除证据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function appendLowerPriorityExclusions(exclusions: readonly ExcludedCandidateEvidence[], lowerCandidates: readonly RuleCandidateEvidence[]): ExcludedCandidateEvidence[] {
  return [...exclusions, ...lowerCandidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    reasonCode: 'lower_priority' as const,
    ...(candidate.matchedRuleIds[0] ? { ruleId: candidate.matchedRuleIds[0] } : {})
  }))];
}

/**
 * 比较规则命中等级和稳定标识。
 *
 * @param left - 左侧证据
 * @param right - 右侧证据
 * @returns 排序结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareEvidence(left: MatchedRuleEvidence, right: MatchedRuleEvidence): number {
  return right.priority - left.priority || right.specificity - left.specificity || compareStableIds(left.ruleId, right.ruleId);
}

/**
 * 比较候选排序等级和稳定标识。
 *
 * @param left - 左侧候选
 * @param right - 右侧候选
 * @returns 排序结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareCandidates(left: RuleCandidateEvidence, right: RuleCandidateEvidence): number {
  return right.priority - left.priority || right.specificity - left.specificity || compareStableIds(left.candidateId, right.candidateId);
}

/**
 * 判断两个结果是否处于相同排序等级。
 *
 * @param left - 左侧结果
 * @param right - 右侧结果
 * @returns 是否同等级
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sameRank(left: { priority: number; specificity: number }, right: { priority: number; specificity: number }): boolean {
  return left.priority === right.priority && left.specificity === right.specificity;
}

/**
 * 按风险等级从低到高选择最高值。
 *
 * @param levels - 可选风险等级
 * @returns 最高风险等级
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function highestRisk(levels: readonly MatchedRuleEvidence['riskLevel'][]): MatchedRuleEvidence['riskLevel'] {
  const order = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const defined = levels.filter((level): level is keyof typeof order => level !== undefined);
  return defined.sort((left, right) => order[right] - order[left])[0];
}

/**
 * 去重并保留证据首次出现顺序。
 *
 * @param values - 待去重值
 * @returns 稳定去重结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * 以 code point 顺序比较两个标识，避免 locale 造成回放漂移。
 *
 * @param left - 左侧标识
 * @param right - 右侧标识
 * @returns 比较结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareStableIds(left: string, right: string): number {
  const leftSymbols = Array.from(left);
  const rightSymbols = Array.from(right);
  const commonLength = Math.min(leftSymbols.length, rightSymbols.length);
  const differences = leftSymbols.slice(0, commonLength).map((symbol, index) => symbol.codePointAt(0)! - (rightSymbols[index]?.codePointAt(0) ?? 0));
  return differences.find((difference) => difference !== 0) ?? leftSymbols.length - rightSymbols.length;
}
