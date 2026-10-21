/**
 * 执行候选规则并将表达式结果转换成可审计证据。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { CandidateRule, ExcludedCandidateEvidence, ExpressionResult, MatchedRuleEvidence, RuleEvaluationFacts, RuleEvaluationResult } from './types.js';
import { evaluateExpression } from './expression-evaluator.js';
import { aggregateCandidates, resolveCandidates } from './candidate-evidence.js';

/**
 * 评估有限候选规则。
 *
 * @param input - 事实、规则和可选宿主门禁
 * @returns 候选、排除和冲突证据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function evaluateCandidateRules(input: {
  facts: RuleEvaluationFacts;
  rules: readonly CandidateRule[];
  guards?: ReadonlyMap<string, ExcludedCandidateEvidence>;
}): RuleEvaluationResult {
  const evaluations = input.rules.map((candidateRule) => evaluateCandidateRule(input.facts, candidateRule, input.guards));
  const matchedRules = evaluations.flatMap((evaluation) => evaluation.matched ? [evaluation.evidence] : []);
  const exclusions = evaluations.flatMap((evaluation) => evaluation.matched ? [] : [evaluation.exclusion]);
  return resolveCandidates(aggregateCandidates(matchedRules), matchedRules, exclusions);
}

/**
 * 评估单条候选规则，优先应用宿主状态门禁。
 *
 * @param facts - 当前不可变事实
 * @param candidateRule - 带候选标识的规则
 * @param guards - 宿主状态和授权排除原因
 * @returns 匹配或排除结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateCandidateRule(facts: RuleEvaluationFacts, candidateRule: CandidateRule, guards: ReadonlyMap<string, ExcludedCandidateEvidence> | undefined): { matched: true; evidence: MatchedRuleEvidence } | { matched: false; exclusion: ExcludedCandidateEvidence } {
  const guard = guards?.get(candidateRule.candidateId);
  // disabled、授权和 Function 归属门禁优先于业务规则。
  if (guard) return { matched: false, exclusion: { ...guard, ruleId: candidateRule.rule.ruleId, ruleVersion: candidateRule.rule.version } };
  const expression = evaluateExpression({ expression: candidateRule.rule.expression, facts, unknownFieldPolicy: candidateRule.rule.unknownFieldPolicy });
  // 只有完整命中规则才进入候选排序。
  if (expression.state === 'matched') return { matched: true, evidence: toMatchedEvidence(candidateRule, expression) };
  return { matched: false, exclusion: toRuleExclusion(candidateRule, expression) };
}

/**
 * 生成命中规则证据，并复制数组消除输入别名。
 *
 * @param candidateRule - 已命中的规则
 * @param expression - 表达式结果
 * @returns 命中证据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toMatchedEvidence(candidateRule: CandidateRule, expression: ExpressionResult): MatchedRuleEvidence {
  const evidenceCodes = uniqueStrings([...(candidateRule.evidenceCodes ?? []), ...(expression.evidenceCode ? [expression.evidenceCode] : [])]);
  const evidence: MatchedRuleEvidence = {
    candidateId: candidateRule.candidateId,
    ruleId: candidateRule.rule.ruleId,
    ruleVersion: candidateRule.rule.version,
    priority: candidateRule.rule.priority,
    specificity: candidateRule.rule.specificity,
    requiredSlots: [...(candidateRule.requiredSlots ?? [])],
    evidenceCodes
  };
  // 风险和确认元数据只有在规则显式声明时才写入结果。
  const withRisk = candidateRule.riskLevel === undefined ? evidence : { ...evidence, riskLevel: candidateRule.riskLevel };
  if (candidateRule.requiresConfirmation === undefined) return withRisk;
  return { ...withRisk, requiresConfirmation: candidateRule.requiresConfirmation };
}

/**
 * 将表达式失败转换为稳定排除原因。
 *
 * @param candidateRule - 未命中的规则
 * @param expression - 表达式结果
 * @returns 排除证据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toRuleExclusion(candidateRule: CandidateRule, expression: ExpressionResult): ExcludedCandidateEvidence {
  const reasonCode = expression.evidenceCode === 'unknown_field_rejected'
    ? 'unknown_field_rejected'
    : expression.evidenceCode === 'unknown_field' ? 'unknown_field'
      : expression.evidenceCode === 'none_condition_matched' ? 'none_condition_matched'
      : expression.evidenceCode === 'invalid_rule' ? 'invalid_rule' : 'rule_not_matched';
  const exclusion: ExcludedCandidateEvidence = { candidateId: candidateRule.candidateId, ruleId: candidateRule.rule.ruleId, ruleVersion: candidateRule.rule.version, reasonCode };
  // NONE、unknown 和 invalid rule 的细分证据不能丢失。
  if (expression.evidenceCode === undefined) return exclusion;
  return { ...exclusion, evidenceCode: expression.evidenceCode };
}

/**
 * 去重并复制字符串证据。
 *
 * @param values - 规则证据
 * @returns 稳定数组
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
