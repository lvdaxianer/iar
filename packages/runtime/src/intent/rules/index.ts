/**
 * 暴露 IAR 受限 Function/Plugin 规则引擎。
 *
 * 规则引擎只生成有限候选与证据，不选择授权、不执行 Action，也不修改运行时上下文。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type {
  FunctionRule,
  FunctionRuleEvaluationInput,
  PluginRule,
  PluginRuleEvaluationInput,
  RuleEvaluationResult
} from './types.js';
import { validateContract } from '@iar/contracts';
import { createPluginGuards, evaluateCandidateRules } from './evaluation.js';
import type { CandidateRule } from './types.js';

const MAX_FACT_DEPTH = 64;
const MAX_FACT_NODES = 4096;

type JsonSafeContext = { budget: { nodes: number }; depth: number; path: WeakSet<object> };

export * from './types.js';

/**
 * 运行 FunctionRule 和 PluginRule 的纯内存评估器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class RuleEngine {
  /**
   * 评估 FunctionRule，生成有限 Function 候选。
   *
   * @param input - Function 规则和事实
   * @returns 命中、排除或澄清结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public evaluateFunctions(input: FunctionRuleEvaluationInput): RuleEvaluationResult {
    // SemanticFrame 和 BehaviorContext 只能以 JSON-safe 事实进入规则求值。
    if (!isJsonSafe(input.facts)) return invalidRuleResult('facts');
    const invalid = input.rules.find((rule) => !isFunctionRuleValid(rule));
    // Function 阶段拒绝 target 不匹配或 Schema 无效的运行时输入。
    if (invalid) return invalidRuleResult(invalid.functionId);
    const rules = input.rules.map(toFunctionCandidateRule);
    return evaluateCandidateRules({ facts: input.facts, rules });
  }

  /**
   * 评估已选 Function 内的 PluginRule，并先应用宿主状态门禁。
   *
   * @param input - Function、插件快照、PluginRule 和事实
   * @returns 有限插件候选及完整证据
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public evaluatePlugins(input: PluginRuleEvaluationInput): RuleEvaluationResult {
    // PluginRule 同样拒绝循环对象、函数和非有限数字事实。
    if (!isJsonSafe(input.facts)) return invalidRuleResult('facts');
    const invalid = input.rules.find((rule) => !isPluginRuleValid(rule));
    // Plugin 阶段拒绝 target 不匹配或 Schema 无效的运行时输入。
    if (invalid) return invalidRuleResult(invalid.pluginId);
    const rules = input.rules.map(toPluginCandidateRule);
    const guards = createPluginGuards(input.functionId, input.candidates, rules);
    return evaluateCandidateRules({ facts: input.facts, rules, guards });
  }
}
/**
 * 检查 FunctionRule 的运行时结构和目标边界。
 *
 * @param source - 未信任的 FunctionRule
 * @returns 规则是否可进入求值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isFunctionRuleValid(source: unknown): boolean {
  // 缺少 Function 标识时不能进入公共 Rule Schema 校验后的映射。
  if (!isRecord(source) || typeof source.functionId !== 'string') return false;
  return isRuleDefinitionValid(source.rule, 'function');
}

/**
 * 检查 PluginRule 的运行时结构和目标边界。
 *
 * @param source - 未信任的 PluginRule
 * @returns 规则是否可进入求值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isPluginRuleValid(source: unknown): boolean {
  // Plugin 必须同时声明插件标识和所属 Function。
  if (!isRecord(source) || typeof source.pluginId !== 'string' || typeof source.functionId !== 'string') return false;
  return isRuleDefinitionValid(source.rule, 'plugin');
}

/**
 * 使用公共 Rule Schema 并检查目标类型。
 *
 * @param source - 未信任的 RuleDefinition
 * @param target - 当前阶段允许的目标
 * @returns RuleDefinition 是否有效
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRuleDefinitionValid(source: unknown, target: 'function' | 'plugin'): boolean {
  const result = validateContract('rule', source);
  // Schema 失败或非对象都不能读取 target。
  if (!result.ok || !isRecord(source)) return false;
  // 目标类型必须与当前评估阶段一致。
  return source.target === target;
}

/**
 * 判断未知值是否为普通对象。
 *
 * @param value - 待判断值
 * @returns 是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 创建规则运行时校验失败结果。
 *
 * @param candidateId - 可能的候选标识
 * @returns 稳定拒绝结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function invalidRuleResult(candidateId: string): RuleEvaluationResult {
  return {
    status: 'rejected',
    candidates: [],
    matchedRules: [],
    excludedCandidates: [{ candidateId: candidateId || 'unknown-candidate', reasonCode: 'invalid_rule' }],
    conflicts: []
  };
}

/**
 * 递归校验事实是否为无循环 JSON-safe 值。
 *
 * @param value - 待校验事实
 * @param context - 当前事实节点预算、深度和路径
 * @returns 是否可安全回放
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isJsonSafe(value: unknown, context: JsonSafeContext = { budget: { nodes: 0 }, depth: 0, path: new WeakSet<object>() }): boolean {
  // JSON 原子值不需要容器递归。
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  // 非有限数字不能进入可回放事实。
  if (typeof value === 'number') return Number.isFinite(value);
  // 其他 primitive 类型不属于 JSON facts。
  if (typeof value !== 'object') return false;
  // 容器边界失败时不再修改路径或预算。
  if (!canTraverseFacts(value, context)) return false;
  context.path.add(value);
  context.budget.nodes += 1;
  const valid = traverseFacts(value, context);
  context.path.delete(value);
  return valid;
}

/**
 * 判断事实容器是否可以继续递归。
 *
 * @param value - 待校验容器
 * @param context - 当前事实预算和递归路径
 * @returns 是否允许遍历
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function canTraverseFacts(value: object, context: JsonSafeContext): boolean {
  // 深度和总节点数共同限制验证资源。
  if (context.depth > MAX_FACT_DEPTH || context.budget.nodes >= MAX_FACT_NODES) return false;
  // 当前路径重复代表循环引用。
  if (context.path.has(value)) return false;
  // 数组或普通对象才是可回放 facts 容器。
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 递归遍历事实容器的元素或自有属性。
 *
 * @param value - 已通过容器校验的事实
 * @param context - 当前事实预算和递归路径
 * @returns 所有子值是否安全
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function traverseFacts(value: object, context: JsonSafeContext): boolean {
  const next = { ...context, depth: context.depth + 1 };
  return Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, next))
    : Object.values(value).every((item) => isJsonSafe(item, next));
}

/**
 * 将 FunctionRule 映射为引擎内部候选规则。
 *
 * @param source - 公共 FunctionRule
 * @returns 内部候选规则
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toFunctionCandidateRule(source: FunctionRule): CandidateRule {
  const base: CandidateRule = {
    candidateId: source.functionId,
    functionId: source.functionId,
    rule: source.rule
  };
  return addRuleMetadata(base, source);
}

/**
 * 将 PluginRule 映射为引擎内部候选规则。
 *
 * @param source - 公共 PluginRule
 * @returns 内部候选规则
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toPluginCandidateRule(source: PluginRule): CandidateRule {
  const base: CandidateRule = {
    candidateId: source.pluginId,
    functionId: source.functionId,
    rule: source.rule
  };
  const withMetadata = addRuleMetadata(base, source);
  // 未声明能力时不写入伪造的能力限制。
  if (source.requiredCapabilities === undefined) return withMetadata;
  return { ...withMetadata, requiredCapabilities: source.requiredCapabilities };
}

/**
 * 复制规则输出元数据，保持未声明字段不会伪造默认权限。
 *
 * @param base - 基础候选规则
 * @param source - FunctionRule 或 PluginRule
 * @returns 带元数据的候选规则
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function addRuleMetadata(base: CandidateRule, source: FunctionRule | PluginRule): CandidateRule {
  // 每个可选元数据只在调用方明确声明时复制。
  const withSlots = source.requiredSlots === undefined ? base : { ...base, requiredSlots: source.requiredSlots };
  const withRisk = source.riskLevel === undefined ? withSlots : { ...withSlots, riskLevel: source.riskLevel };
  const withEvidence = source.evidenceCodes === undefined ? withRisk : { ...withRisk, evidenceCodes: source.evidenceCodes };
  // 未声明确认要求时保留候选的未确认状态。
  if (source.requiresConfirmation === undefined) return withEvidence;
  return { ...withEvidence, requiresConfirmation: source.requiresConfirmation };
}
