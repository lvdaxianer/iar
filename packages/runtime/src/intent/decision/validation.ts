/**
 * 校验不可信 DecisionProvider 输出，并将其收敛为稳定结果。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ACTION_TYPES, SCHEMA_VERSIONS, validateContract, type DecisionResult } from '@iar/contracts';
import type { DecisionCandidate, DecisionRequest, SelectionDecisionType } from './types.js';

const MIN_SCORE = 0;
const MAX_SCORE = 1;

/**
 * 校验 provider 原始结果和当前候选边界。
 *
 * @param request - 当前决策约束
 * @param raw - provider 未信任输出
 * @returns 稳定 DecisionResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validateDecisionOutput(request: DecisionRequest, raw: unknown): DecisionResult {
  const candidates = Array.isArray(request?.candidates) ? request.candidates : [];
  const candidateIds = candidateIdsOf(candidates);
  // 请求边界失败时返回稳定拒绝，不读取 provider 输出。
  if (!isValidRequest(request, candidateIds)) return result({ request, candidateIds, status: 'rejected', reasonCode: 'invalid_decision_request' });
  // 空候选没有可执行选择，直接返回 noul。
  if (candidateIds.length === 0) return result({ request, candidateIds, status: 'noul', reasonCode: 'candidate_empty' });
  // 最高等级并列必须澄清，避免 provider 静默猜测。
  if (hasIndistinguishableTopCandidates(candidates)) return result({ request, candidateIds, status: 'needs_clarification', reasonCode: 'indistinguishable_candidates' });
  const parsed = parseDecision(raw);
  // Schema 失败不能进入状态归一化。
  if (!parsed) return result({ request, candidateIds, status: 'rejected', reasonCode: 'invalid_decision_output' });
  // provider 不能改变决策阶段或版本。
  if (!matchesDecisionStage(parsed, request)) return result({ request, candidateIds, status: 'rejected', reasonCode: 'invalid_decision_output' });
  // provider 不能增加、删除或重排受约束候选。
  if (!sameIds(parsed.candidateIds, candidateIds)) return result({ request, candidateIds, status: 'rejected', reasonCode: 'candidate_set_mismatch' });
  return normalizeStatus(request, parsed, candidateIds);
}

/**
 * 判断是否需要调用 provider 产生原始输出。
 *
 * @param request - 当前决策约束
 * @returns 是否允许进入 provider
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function shouldInvokeProvider(request: DecisionRequest): boolean {
  const candidates = Array.isArray(request?.candidates) ? request.candidates : [];
  const candidateIds = candidateIdsOf(candidates);
  return isValidRequest(request, candidateIds) && candidateIds.length > 0 && !hasIndistinguishableTopCandidates(candidates);
}

/**
 * 将 provider 异常转换为可诊断的稳定拒绝结果。
 *
 * @param request - 当前决策约束
 * @returns provider_failed 拒绝结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function providerFailureResult(request: DecisionRequest): DecisionResult {
  const candidates = Array.isArray(request?.candidates) ? request.candidates : [];
  return result({ request, candidateIds: candidateIdsOf(candidates), status: 'rejected', reasonCode: 'provider_failed' });
}

/**
 * 将 provider 输出通过公共 Decision Schema 解析。
 *
 * @param raw - provider 未信任输出
 * @returns 已通过 Schema 的 DecisionResult 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseDecision(raw: unknown): DecisionResult | undefined {
  const validation = validateContract('decision', raw);
  // Schema 失败或非普通对象都不能进入候选边界校验。
  if (!validation.ok || !isRecord(validation.value)) return undefined;
  return validation.value as DecisionResult;
}

/**
 * 校验请求的基本边界和候选标识唯一性。
 *
 * @param request - 当前决策约束
 * @param candidateIds - 提取的候选标识
 * @returns 请求是否可安全求值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isValidRequest(request: DecisionRequest, candidateIds: readonly string[]): boolean {
  return isRecord(request)
    && isSelectionType(request.decisionType)
    && typeof request.decisionVersion === 'string' && request.decisionVersion.length > 0
    && Number.isFinite(request.threshold) && request.threshold >= MIN_SCORE && request.threshold <= MAX_SCORE
    && Array.isArray(request.candidates)
    && request.candidates.length === candidateIds.length
    && request.candidates.every(isValidCandidate)
    && candidateIds.length === new Set(candidateIds).size;
}

/**
 * 判断候选是否具备可排序的有限数值。
 *
 * @param candidate - 待校验候选
 * @returns 候选是否满足运行时边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isValidCandidate(candidate: DecisionCandidate): boolean {
  const allowedKeys = new Set(['candidateId', 'priority', 'specificity', 'requiredSlots', 'riskLevel', 'evidenceCodes', 'description', 'functionId', 'actionTypes']);
  return isRecord(candidate)
    && Object.keys(candidate).every((key) => allowedKeys.has(key))
    && typeof candidate.candidateId === 'string'
    && candidate.candidateId.length > 0
    && Number.isFinite(candidate.priority)
    && Number.isFinite(candidate.specificity)
    && isOptionalStringArray(candidate.requiredSlots)
    && isOptionalStringArray(candidate.evidenceCodes)
    && isOptionalBoundedString(candidate.description)
    && isOptionalBoundedString(candidate.functionId)
    && isOptionalActionTypes(candidate.actionTypes)
    && isOptionalRiskLevel(candidate.riskLevel);
}

function isOptionalBoundedString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 256);
}

function isOptionalActionTypes(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.length > 0 && value.length <= ACTION_TYPES.length && new Set(value).size === value.length && value.every((item) => ACTION_TYPES.includes(item as typeof ACTION_TYPES[number])));
}

/**
 * 校验候选中的可选字符串数组。
 *
 * @param value - 待校验的可选数组
 * @returns 数组缺省或每项均为非空字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0));
}

/**
 * 校验候选中的可选风险等级。
 *
 * @param value - 待校验风险等级
 * @returns 风险等级缺省或属于公共枚举
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isOptionalRiskLevel(value: unknown): boolean {
  return value === undefined || value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

/**
 * 判断请求是否属于本地允许的选择阶段。
 *
 * @param decisionType - 请求的决策类型
 * @returns 是否为 Function 或 Plugin 选择
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isSelectionType(decisionType: unknown): decisionType is DecisionRequest['decisionType'] {
  // 只有两个本地选择阶段允许直接消费候选。
  return decisionType === 'function.select' || decisionType === 'plugin.select';
}

/**
 * 判断最高排序等级是否存在并列候选。
 *
 * @param candidates - 有限候选集合
 * @returns 是否必须请求澄清
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasIndistinguishableTopCandidates(candidates: readonly DecisionCandidate[]): boolean {
  const highest = candidates.reduce((current, candidate) => higherRank(candidate, current) ? candidate : current, candidates[0]);
  return highest !== undefined && candidates.filter((candidate) => sameRank(candidate, highest)).length > 1;
}

/**
 * 比较两个候选的排序等级。
 *
 * @param left - 左侧候选
 * @param right - 右侧候选
 * @returns 左侧是否更高
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function higherRank(left: DecisionCandidate, right: DecisionCandidate | undefined): boolean {
  // 空右侧表示当前候选成为初始最高等级。
  if (!right) return true;
  // priority 先于 specificity 决定相对等级。
  return left.priority > right.priority || (left.priority === right.priority && left.specificity > right.specificity);
}

/**
 * 判断两个候选是否处于相同排序等级。
 *
 * @param left - 左侧候选
 * @param right - 右侧候选
 * @returns 是否相同等级
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sameRank(left: DecisionCandidate, right: DecisionCandidate): boolean {
  return left.priority === right.priority && left.specificity === right.specificity;
}

/**
 * 确认 provider 结果仍绑定当前请求。
 *
 * @param decision - 已通过公共 Schema 的结果
 * @param request - 当前决策约束
 * @returns 是否保持版本、阶段和候选边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchesDecisionStage(decision: DecisionResult, request: DecisionRequest): boolean {
  // 阶段和版本必须都与调用方约束一致。
  return decision.decisionType === request.decisionType
    && decision.decisionVersion === request.decisionVersion;
}

/**
 * 根据状态校验 choice 和 score，并处理低置信度结果。
 *
 * @param request - 当前决策约束
 * @param decision - 已通过结构和边界校验的结果
 * @param candidateIds - 请求候选标识
 * @returns 规范化决策结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function normalizeStatus(request: DecisionRequest, decision: DecisionResult, candidateIds: readonly string[]): DecisionResult {
  // 非 choice 状态不应携带可执行选择字段。
  if (decision.status !== 'choice') return normalizeNonChoice(decision, candidateIds);
  // choice 缺失或不在集合中时拒绝，而不是选择替代项。
  if (!decision.choice || !candidateIds.includes(decision.choice)) return result({ request, candidateIds, status: 'rejected', reasonCode: 'choice_not_in_candidates' });
  // choice 必须携带有限分数。
  if (!isValidScore(decision.score)) return result({ request, candidateIds, status: 'rejected', reasonCode: 'invalid_score' });
  // 低分只能澄清，不能保留可执行 choice。
  if (decision.score < request.threshold) return { ...result({ request, candidateIds, status: 'needs_clarification', reasonCode: 'score_below_threshold' }), score: decision.score };
  return decision;
}

/**
 * 校验无需执行选择的结果不能携带 choice。
 *
 * @param decision - provider 的非 choice 结果
 * @param candidateIds - 请求候选标识
 * @returns 规范化非 choice 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function normalizeNonChoice(decision: DecisionResult, candidateIds: readonly string[]): DecisionResult {
  const withoutOptional = { ...decision };
  delete withoutOptional.choice;
  delete withoutOptional.score;
  // 非 choice 结果带有 choice 或非法 score 时必须降为拒绝。
  if (decision.choice !== undefined || (decision.score !== undefined && !isValidScore(decision.score))) {
    return { ...withoutOptional, status: 'rejected', reasonCode: 'invalid_decision_output', candidateIds: [...candidateIds] };
  }
  return { ...withoutOptional, candidateIds: [...candidateIds] };
}

type ResultOptions = {
  request: DecisionRequest;
  candidateIds: readonly string[];
  status: DecisionResult['status'];
  reasonCode: string;
};

/**
 * 构造统一的稳定结果。
 *
 * @param options - 请求、候选、状态和原因
 * @returns 版本化 DecisionResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function result(options: ResultOptions): DecisionResult {
  const { request, candidateIds, status, reasonCode } = options;
  const decisionType: SelectionDecisionType = isSelectionType(request?.decisionType) ? request.decisionType : 'function.select';
  const decisionVersion = typeof request?.decisionVersion === 'string' && request.decisionVersion.length > 0 ? request.decisionVersion : 'unknown';
  return {
    schemaVersion: SCHEMA_VERSIONS.decision,
    decisionType,
    decisionVersion,
    status,
    reasonCode,
    candidateIds: [...candidateIds]
  };
}

/**
 * 提取候选标识并拒绝空标识。
 *
 * @param candidates - 候选集合
 * @returns 稳定候选标识列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function candidateIdsOf(candidates: readonly DecisionCandidate[]): string[] {
  return candidates.flatMap((candidate) => typeof candidate?.candidateId === 'string' && candidate.candidateId.length > 0 ? [candidate.candidateId] : []);
}

/**
 * 判断两个候选标识数组是否顺序和值都一致。
 *
 * @param left - provider 返回标识
 * @param right - 请求标识
 * @returns 是否完全一致
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((candidateId, index) => candidateId === right[index]);
}

/**
 * 判断 score 是否为有限的闭区间数值。
 *
 * @param score - 待校验分数
 * @returns 分数是否有效
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isValidScore(score: number | undefined): score is number {
  return score !== undefined && Number.isFinite(score) && score >= MIN_SCORE && score <= MAX_SCORE;
}

/**
 * 判断未知值是否为可读取的普通对象。
 *
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
