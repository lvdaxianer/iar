/**
 * 构造 PluginHost 快照上的生命周期、授权、归属和能力门禁。
 *
 * Task 2.3 会在运行时再次向 PluginHost/Policy Gate 复核这些边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { CandidateRule, ExcludedCandidateEvidence, PluginCandidate } from './types.js';

/**
 * 为当前 Function 的插件规则创建稳定排除原因索引。
 *
 * @param functionId - 已选 Function
 * @param candidates - PluginHost/授权层快照
 * @param rules - 当前 Function 的 PluginRule
 * @returns 插件标识到排除证据的映射
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createPluginGuards(functionId: string, candidates: readonly PluginCandidate[], rules: readonly CandidateRule[]): ReadonlyMap<string, ExcludedCandidateEvidence> {
  const candidateMap = new Map(candidates.map((candidate) => [candidate.pluginId, candidate]));
  const entries = rules.map((rule) => [rule.candidateId, pluginGuard(functionId, rule, candidateMap)] as const);
  return new Map(entries.filter((entry): entry is readonly [string, ExcludedCandidateEvidence] => entry[1] !== undefined));
}

/**
 * 计算单个 PluginRule 的状态门禁。
 *
 * @param functionId - 已选 Function
 * @param rule - PluginRule 内部候选
 * @param candidates - 插件快照索引
 * @returns 排除原因，不排除时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function pluginGuard(functionId: string, rule: CandidateRule, candidates: ReadonlyMap<string, PluginCandidate>): ExcludedCandidateEvidence | undefined {
  const candidate = candidates.get(rule.candidateId);
  // 缺失候选不能被规则虚构为可执行插件。
  if (!candidate) return { candidateId: rule.candidateId, reasonCode: 'candidate_unavailable' };
  // Function 所有权是不可越过的路由边界。
  if (candidate.functionId !== functionId || rule.functionId !== functionId) return { candidateId: rule.candidateId, reasonCode: 'function_ownership_mismatch' };
  // disabled 插件必须在规则候选阶段排除。
  if (!candidate.enabled) return { candidateId: rule.candidateId, reasonCode: 'disabled_plugin' };
  // 未授权插件不能进入后续 DecisionProvider。
  if (!candidate.authorized) return { candidateId: rule.candidateId, reasonCode: 'unauthorized_plugin' };
  return missingCapability(candidate, rule);
}

/**
 * 校验插件是否拥有规则要求的全部能力。
 *
 * @param candidate - 插件候选快照
 * @param rule - 当前 PluginRule
 * @returns 能力缺失证据或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function missingCapability(candidate: PluginCandidate, rule: CandidateRule): ExcludedCandidateEvidence | undefined {
  const required = rule.requiredCapabilities ?? [];
  const hasAll = required.every((capability) => candidate.capabilities.includes(capability));
  // 能力白名单不足时保持 fail-closed。
  if (!hasAll) return { candidateId: candidate.pluginId, reasonCode: 'missing_capability' };
  return undefined;
}
