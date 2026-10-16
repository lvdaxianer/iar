/**
 * 计算 ALL、ANY、NONE 和原子条件，并保留未知字段及规则配置证据。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { RuleCondition, RuleExpression } from '@iar/contracts';
import type { ExpressionResult, FieldLookup, RuleEvaluationFacts, RuleEvaluationOptions } from './types.js';
import { evaluatePattern } from './regex-safety.js';

const MAX_EXPRESSION_DEPTH = 64;
const MAX_EXPRESSION_NODES = 512;

/** 当前递归求值的资源预算。 */
type EvaluationBudget = { nodes: number };

/** 递归求值共享的表达式、预算和深度。 */
type EvaluationContext = {
  options: RuleEvaluationOptions;
  budget: EvaluationBudget;
  depth: number;
};

type ComparisonOperator = Exclude<RuleCondition['operator'], 'exists'>;
type ConditionEvaluator = (condition: RuleCondition, actual: unknown) => ExpressionResult;

/** 按操作符分派结构化比较，避免条件分支在新增操作符时无限增长。 */
const CONDITION_EVALUATORS: Record<ComparisonOperator, ConditionEvaluator> = {
  equals: (condition, actual) => booleanResult(deepEqual(actual, condition.value)),
  contains: (condition, actual) => booleanResult(containsValue(actual, condition.value)),
  in: (condition, actual) => booleanResult(Array.isArray(condition.value) && condition.value.some((item) => deepEqual(actual, item))),
  matches: (condition, actual) => evaluatePattern(actual, condition.value)
};

/**
 * 递归求值规则表达式。
 *
 * @param options - 表达式、事实和未知字段策略
 * @returns 表达式结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function evaluateExpression(options: RuleEvaluationOptions): ExpressionResult {
  return evaluateExpressionAtDepth({ options, budget: { nodes: 0 }, depth: 0 });
}

/**
 * 在深度和节点预算内计算表达式。
 *
 * @param context - 表达式、预算和当前递归深度
 * @returns 表达式结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateExpressionAtDepth(context: EvaluationContext): ExpressionResult {
  // 深度或节点预算耗尽时 fail-closed，不再读取子表达式。
  if (context.depth > MAX_EXPRESSION_DEPTH || context.budget.nodes >= MAX_EXPRESSION_NODES) return { state: 'rejected', evidenceCode: 'invalid_rule' };
  context.budget.nodes += 1;
  const { expression } = context.options;
  // ALL 要求所有可识别子条件命中。
  if ('all' in expression) return evaluateAll(expression.all, context);
  // ANY 只接受明确命中，未知字段不会扩大候选范围。
  if ('any' in expression) return evaluateAny(expression.any, context);
  // NONE 命中任意排除条件时拒绝候选。
  if ('none' in expression) return evaluateNone(expression.none, context);
  return evaluateCondition(expression.condition, context.options.facts, context.options.unknownFieldPolicy);
}

/**
 * 计算 ALL 表达式。
 *
 * @param expressions - ALL 子表达式
 * @param context - 共享事实、策略和预算
 * @returns ALL 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateAll(expressions: readonly RuleExpression[], context: EvaluationContext): ExpressionResult {
  const results = evaluateChildren(expressions, context);
  // reject 优先传播，防止显式拒绝被真值掩盖。
  const rejected = results.find((result) => result.state === 'rejected');
  if (rejected) return rejected;
  // 任意明确失败都会使 ALL 失败。
  const failed = results.find((result) => result.state === 'not_matched');
  if (failed) return failed;
  // 纯未知且 ignore 的 ALL 不得扩大候选范围。
  if (!results.some((result) => result.state === 'matched')) return { state: 'not_matched' };
  return attachEvidence({ state: 'matched' }, findEvidenceCode(results));
}

/**
 * 计算 ANY 表达式。
 *
 * @param expressions - ANY 子表达式
 * @param context - 共享事实、策略和预算
 * @returns ANY 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateAny(expressions: readonly RuleExpression[], context: EvaluationContext): ExpressionResult {
  const results = evaluateChildren(expressions, context);
  // reject 优先传播，配置错误不能被其他命中条件掩盖。
  const rejected = results.find((result) => result.state === 'rejected');
  if (rejected) return rejected;
  // ANY 只要有一个明确命中即可通过。
  const matched = results.find((result) => result.state === 'matched');
  if (matched) return attachEvidence(matched, findEvidenceCode(results));
  return { state: 'not_matched' };
}

/**
 * 计算 NONE 表达式。
 *
 * @param expressions - NONE 子表达式
 * @param context - 共享事实、策略和预算
 * @returns NONE 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateNone(expressions: readonly RuleExpression[], context: EvaluationContext): ExpressionResult {
  const results = evaluateChildren(expressions, context);
  // reject 优先传播，未知字段 reject 不能静默放行。
  const rejected = results.find((result) => result.state === 'rejected');
  if (rejected) return rejected;
  // NONE 的明确命中会排除当前候选。
  if (results.some((result) => result.state === 'matched')) return { state: 'not_matched', evidenceCode: 'none_condition_matched' };
  return attachEvidence({ state: 'matched' }, findEvidenceCode(results));
}

/**
 * 批量递归计算子表达式。
 *
 * @param expressions - 子表达式列表
 * @param context - 共享事实、策略和预算
 * @returns 子表达式结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateChildren(expressions: readonly RuleExpression[], context: EvaluationContext): ExpressionResult[] {
  const results: ExpressionResult[] = [];
  for (const expression of expressions) {
    // 宽度预算达到上限时停止遍历，避免继续分配结果数组。
    if (context.budget.nodes >= MAX_EXPRESSION_NODES) return [{ state: 'rejected', evidenceCode: 'invalid_rule' }];
    results.push(evaluateExpressionAtDepth({
      options: { ...context.options, expression },
      budget: context.budget,
      depth: context.depth + 1
    }));
  }
  return results;
}

/**
 * 计算原子条件。
 *
 * @param condition - 原子条件
 * @param facts - 结构化事实
 * @param policy - 未知字段策略
 * @returns 原子条件结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateCondition(condition: RuleCondition, facts: RuleEvaluationFacts, policy: RuleEvaluationOptions['unknownFieldPolicy']): ExpressionResult {
  const lookup = lookupField(facts, condition.field);
  // exists 专门判断字段是否存在，不读取可选 value。
  if (condition.operator === 'exists') return booleanResult(lookup.exists);
  // 其他操作符遇到未知字段时遵守规则声明。
  if (!lookup.exists) return unknownFieldResult(policy);
  return evaluateKnownCondition(condition, lookup.value);
}

/**
 * 计算字段已知时的比较操作。
 *
 * @param condition - 原子条件
 * @param actual - 实际字段值
 * @returns 比较结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluateKnownCondition(condition: RuleCondition, actual: unknown): ExpressionResult {
  const evaluator = CONDITION_EVALUATORS[condition.operator as ComparisonOperator];
  // 未知操作符不能默认落入 matches，必须稳定拒绝。
  if (!evaluator) return { state: 'rejected', evidenceCode: 'invalid_rule' };
  return evaluator(condition, actual);
}

/**
 * 将布尔比较转换为表达式结果。
 *
 * @param matched - 比较是否命中
 * @returns 表达式结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function booleanResult(matched: boolean): ExpressionResult {
  return matched ? { state: 'matched' } : { state: 'not_matched' };
}

/**
 * 处理未知字段策略。
 *
 * @param policy - 规则声明的策略
 * @returns 未知字段结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function unknownFieldResult(policy: RuleEvaluationOptions['unknownFieldPolicy']): ExpressionResult {
  // reject 将未知字段升级为稳定拒绝。
  if (policy === 'reject') return { state: 'rejected', evidenceCode: 'unknown_field_rejected' };
  // ignore 跳过叶子但保留审计证据。
  if (policy === 'ignore') return { state: 'ignored', evidenceCode: 'unknown_field' };
  return { state: 'not_matched', evidenceCode: 'unknown_field' };
}

/**
 * 读取事实中的点号路径。
 *
 * @param facts - 根事实对象
 * @param field - 点号路径
 * @returns 字段查找结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function lookupField(facts: RuleEvaluationFacts, field: string): FieldLookup {
  return field.split('.').reduce<FieldLookup>((current, segment) => {
    // 当前路径不存在时不再读取后续段。
    if (!current.exists) return current;
    const value = current.value as Record<string, unknown> | undefined;
    // 只读取自有字段，避免规则访问原型属性。
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) return { exists: false };
    return { exists: true, value: value[segment] };
  }, { exists: true, value: facts });
}

/**
 * 进行 JSON 结构比较。
 *
 * @param left - 实际值
 * @param right - 规则值
 * @param seen - 当前递归路径上的对象对
 * @returns 是否结构相等
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function deepEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  // 原始值和同一引用无需递归，直接保持 JSON 比较语义。
  if (Object.is(left, right)) return true;
  // 任一侧不是对象时，只有 Object.is 才能判定为相等。
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  // 当前路径上的对象对直接视为相等，避免循环值导致栈溢出。
  if (seen.get(left) === right) return true;
  // 同一路径中同一左值指向不同右值时不是同一结构。
  if (seen.has(left)) return false;
  seen.set(left, right);
  // 数组和对象不能互相视为同一 JSON 结构。
  const equal = Array.isArray(left) || Array.isArray(right)
    ? compareArrays(left, right, seen)
    : compareObjects(left, right, seen);
  // 只保留当前递归路径，允许兄弟属性复用共享引用。
  seen.delete(left);
  return equal;
}

/**
 * 比较两个数组。
 *
 * @param left - 左侧值
 * @param right - 右侧值
 * @param seen - 当前递归路径上的对象对
 * @returns 是否相等
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareArrays(left: unknown, right: unknown, seen: WeakMap<object, object>): boolean {
  // 类型或长度不同的数组不能结构相等。
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => deepEqual(value, right[index], seen));
}

/**
 * 比较两个对象并忽略属性插入顺序。
 *
 * @param left - 左侧对象
 * @param right - 右侧对象
 * @param seen - 当前递归路径上的对象对
 * @returns 是否相等
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareObjects(left: object, right: object, seen: WeakMap<object, object>): boolean {
  // 只比较普通对象，避免读取自定义原型上的隐式字段。
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key], seen));
}

/**
 * 判断字符串或数组是否包含期望值。
 *
 * @param actual - 实际值
 * @param expected - 期望值
 * @returns 是否包含
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function containsValue(actual: unknown, expected: unknown): boolean {
  // 字符串使用子串语义，且 expected 必须同为字符串。
  if (typeof actual === 'string') return typeof expected === 'string' && actual.includes(expected);
  // 数组使用结构化元素比较，避免引用相等造成误判。
  if (Array.isArray(actual)) return actual.some((item) => deepEqual(item, expected));
  // 其他事实类型不支持 contains。
  return false;
}

/**
 * 找出子表达式保留的第一个证据码。
 *
 * @param results - 子表达式结果
 * @returns 可选证据码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function findEvidenceCode(results: readonly ExpressionResult[]): ExpressionResult['evidenceCode'] {
  return results.find((result) => result.evidenceCode !== undefined)?.evidenceCode;
}

/**
 * 在结果存在时附加证据码，避免写入 undefined 属性。
 *
 * @param result - 基础结果
 * @param evidenceCode - 可选证据码
 * @returns 带证据的结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function attachEvidence(result: ExpressionResult, evidenceCode: ExpressionResult['evidenceCode']): ExpressionResult {
  // 没有证据码时保持结果对象原样，避免写入 undefined 字段。
  if (evidenceCode === undefined) return result;
  // 有证据码时复制结果，保持输入对象不可变。
  return { ...result, evidenceCode };
}
