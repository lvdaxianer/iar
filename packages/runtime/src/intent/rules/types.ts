/**
 * 定义受限规则引擎的输入、证据和有限候选结果。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { RiskLevel, RuleDefinition, RuleExpression, UnknownFieldPolicy } from '@iar/contracts';

/** 规则读取的结构化事实集合。 */
export type RuleEvaluationFacts = Readonly<Record<string, unknown>>;

/** Function 规则的固定候选和可审计输出元数据。 */
export type FunctionRule = {
  // Function 候选标识，也是后续归属校验的边界。
  functionId: string;
  // 公共规则定义，target 必须为 function。
  rule: RuleDefinition & { target: 'function' };
  // 规则命中后需要补齐的槽位。
  requiredSlots?: readonly string[];
  // 规则声明的风险等级。
  riskLevel?: RiskLevel;
  // 供审计和回放使用的证据码。
  evidenceCodes?: readonly string[];
  // 高风险候选是否需要后续确认。
  requiresConfirmation?: boolean;
};

/** Plugin 规则的 Function 归属、候选插件和能力约束。 */
export type PluginRule = {
  // 插件候选标识。
  pluginId: string;
  // PluginRule 所属的 Function 边界。
  functionId: string;
  // 公共规则定义，target 必须为 plugin。
  rule: RuleDefinition & { target: 'plugin' };
  // 插件必须具备的能力白名单。
  requiredCapabilities?: readonly string[];
  // 命中候选是否需要确认。
  requiresConfirmation?: boolean;
  // 规则命中后需要补齐的槽位。
  requiredSlots?: readonly string[];
  // 规则声明的风险等级。
  riskLevel?: RiskLevel;
  // 供审计和回放使用的证据码。
  evidenceCodes?: readonly string[];
};

/** PluginHost 提供给规则引擎的当前插件候选快照。 */
export type PluginCandidate = {
  // PluginHost 的稳定插件标识。
  pluginId: string;
  // PluginHost 固定的 Function 归属。
  functionId: string;
  // 当前生命周期是否允许新路由。
  enabled: boolean;
  // 当前 actor/tenant 是否被授权。
  authorized: boolean;
  // 已安装 Manifest 的能力快照。
  capabilities: readonly string[];
};

/** Function 规则评估输入。 */
export type FunctionRuleEvaluationInput = {
  // 当前语义、上下文和主语事实。
  facts: RuleEvaluationFacts;
  // 待评估的 Function 规则集合。
  rules: readonly FunctionRule[];
};

/** Plugin 规则评估输入。 */
export type PluginRuleEvaluationInput = {
  // 当前语义、上下文和主语事实。
  facts: RuleEvaluationFacts;
  // 已选 Function，作为 PluginRule 的硬边界。
  functionId: string;
  // PluginHost 提供的候选快照。
  candidates: readonly PluginCandidate[];
  // 当前 Function 内的 PluginRule 集合。
  rules: readonly PluginRule[];
};

/** 单条命中规则的完整证据。 */
export type MatchedRuleEvidence = {
  // 规则产出的候选标识。
  candidateId: string;
  // 规则稳定标识和版本。
  ruleId: string;
  ruleVersion: string;
  // 用于冲突排序的规则等级。
  priority: number;
  specificity: number;
  // 规则命中后的业务约束。
  requiredSlots: readonly string[];
  riskLevel?: RiskLevel;
  // 命中事实的审计证据码。
  evidenceCodes: readonly string[];
  // 规则声明的确认要求。
  requiresConfirmation?: boolean;
};

/** 单个被排除候选的原因和规则来源。 */
export type ExcludedCandidateEvidence = {
  // 被规则或宿主门禁排除的候选。
  candidateId: string;
  // 可选规则来源，便于回放和解释。
  ruleId?: string;
  ruleVersion?: string;
  // 稳定排除原因。
  reasonCode:
    | 'rule_not_matched'
    | 'none_condition_matched'
    | 'unknown_field'
    | 'unknown_field_rejected'
    | 'disabled_plugin'
    | 'unauthorized_plugin'
    | 'function_ownership_mismatch'
    | 'missing_capability'
    | 'candidate_unavailable'
    | 'invalid_rule'
    | 'lower_priority';
  // 更细粒度的规则证据码。
  evidenceCode?: string;
};

/** 发生最高等级并列时的冲突证据。 */
export type RuleConflictEvidence = {
  // 同等级并列候选。
  candidateIds: readonly string[];
  // 并列排序等级。
  priority: number;
  specificity: number;
  // 产生并列的命中规则。
  ruleIds: readonly string[];
  // 稳定的冲突分类。
  reasonCode: 'equal_priority_and_specificity';
};

/** 决策层可消费的有限候选。 */
export type RuleCandidateEvidence = {
  // 供后续 DecisionProvider 选择的候选。
  candidateId: string;
  // 候选最高命中规则的排序等级。
  priority: number;
  specificity: number;
  // 规则命中后的槽位约束。
  requiredSlots: readonly string[];
  riskLevel?: RiskLevel;
  // 候选所有命中规则的证据码。
  evidenceCodes: readonly string[];
  // 候选所有命中规则的稳定标识。
  matchedRuleIds: readonly string[];
  // 是否需要确认。
  requiresConfirmation?: boolean;
};

/** 规则评估的稳定结果，不修改 BehaviorContext 或 PluginHost。 */
export type RuleEvaluationResult = {
  // 评估结果状态，不代表已授权或已执行。
  status: 'matched' | 'no_match' | 'needs_clarification' | 'rejected';
  // 只有单一最高等级候选时才会设置。
  selectedCandidateId?: string;
  // 后续决策层可见的有限候选。
  candidates: readonly RuleCandidateEvidence[];
  // 所有命中规则的证据。
  matchedRules: readonly MatchedRuleEvidence[];
  // 所有规则和宿主门禁的排除证据。
  excludedCandidates: readonly ExcludedCandidateEvidence[];
  // 并列候选的冲突证据。
  conflicts: readonly RuleConflictEvidence[];
};

/** 内部规则评估输入，保持 Function 与 Plugin 共享一套排序和证据语义。 */
export type CandidateRule = {
  // 规则生成的候选标识。
  candidateId: string;
  // 可选 Function 归属，用于 PluginRule 门禁。
  functionId?: string;
  // 插件门禁需要的能力约束。
  requiredCapabilities?: readonly string[];
  // 候选是否需要后续确认。
  requiresConfirmation?: boolean;
  // 命中候选后等待补齐的槽位。
  requiredSlots?: readonly string[];
  // 候选风险等级。
  riskLevel?: RiskLevel;
  // 候选审计证据码。
  evidenceCodes?: readonly string[];
  // 原始版本化规则。
  rule: RuleDefinition;
};

/** 条件读取结果，区分不存在和存在但值为 undefined 的情况。 */
export type FieldLookup = {
  // 字段是否存在于事实路径中。
  exists: boolean;
  // 字段存在时的原始值。
  value?: unknown;
};

/** 一个规则表达式的三态结果。 */
export type ExpressionResult = {
  // matched/ignored/not_matched/rejected 的三态加忽略状态。
  state: 'matched' | 'not_matched' | 'rejected' | 'ignored';
  // NONE 或未知字段产生的稳定证据码。
  evidenceCode?: 'none_condition_matched' | 'unknown_field' | 'unknown_field_rejected' | 'invalid_rule';
};

/** 规则评估内部配置，保留未知字段策略在规则层声明。 */
export type RuleEvaluationOptions = {
  // 当前递归求值的表达式。
  expression: RuleExpression;
  // 当前请求的不可变事实。
  facts: RuleEvaluationFacts;
  // 规则声明的未知字段策略。
  unknownFieldPolicy: UnknownFieldPolicy;
};
