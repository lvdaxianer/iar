/**
 * 提供受限正则匹配，避免规则配置引入无界 CPU 消耗。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ExpressionResult } from './types.js';

const MAX_PATTERN_LENGTH = 256;

/**
 * 执行长度和嵌套量词均受限的正则匹配。
 *
 * @param actual - 事实中的实际值
 * @param pattern - 规则声明的模式
 * @returns 匹配或配置错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function evaluatePattern(actual: unknown, pattern: unknown): ExpressionResult {
  // 非字符串 pattern 不是可执行的规则配置。
  if (typeof pattern !== 'string') return invalidPattern();
  // 非字符串事实不会命中 matches，但不构成规则配置错误。
  if (typeof actual !== 'string') return { state: 'not_matched' };
  // 长模式和嵌套量词在规则边界直接拒绝，避免无界 CPU 消耗。
  if (pattern.length > MAX_PATTERN_LENGTH || hasNestedQuantifier(pattern)) return invalidPattern();
  try {
    // 合法模式的结果只保留布尔命中状态，不泄漏 RegExp 对象。
    return new RegExp(pattern).test(actual) ? { state: 'matched' } : { state: 'not_matched' };
  } catch {
    // 引擎编译异常统一映射为配置拒绝。
    return invalidPattern();
  }
}

/**
 * 创建稳定的正则配置拒绝结果。
 *
 * @returns invalid_rule 表达式结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function invalidPattern(): ExpressionResult {
  return { state: 'rejected', evidenceCode: 'invalid_rule' };
}

/**
 * 扫描分组和量词，拒绝任意嵌套量词组合。
 *
 * @param pattern - 待检查的正则模式
 * @returns 是否存在嵌套量词
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasNestedQuantifier(pattern: string): boolean {
  const groups: boolean[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    // 转义字符不应被误解为分组或量词。
    if (character === '\\') { index += 1; continue; }
    // 非捕获、前瞻和命名分组的问号不是量词。
    if (character === '?' && pattern[index - 1] === '(') continue;
    // 进入分组时记录该组是否已经包含量词。
    if (character === '(') { groups.push(false); continue; }
    // 关闭已量化的子组时，将量化事实传给父组。
    if (character === ')') { if (closeGroup(groups, pattern[index + 1])) return true; continue; }
    // 组内出现量词会为后续外层量词建立风险标记。
    if (isQuantifier(character) && groups.length > 0) groups[groups.length - 1] = true;
  }
  return false;
}

/**
 * 关闭一个分组并判断外层是否再次量化。
 *
 * @param groups - 分组量化状态栈
 * @param nextCharacter - 右括号后的字符
 * @returns 是否发现嵌套量词
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function closeGroup(groups: boolean[], nextCharacter: string | undefined): boolean {
  const hasQuantifier = groups.pop() ?? false;
  // 当前子组已量化且紧随外层量词时，组合可能导致灾难性回溯。
  if (hasQuantifier && isQuantifier(nextCharacter)) return true;
  // 子组的量化风险向外层传播，等待更外层的量词判断。
  if (hasQuantifier && groups.length > 0) groups[groups.length - 1] = true;
  return false;
}

/**
 * 判断一个字符是否代表正则量词起点。
 *
 * @param character - 待判断字符
 * @returns 是否为量词
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isQuantifier(character: string | undefined): boolean {
  return character === '+' || character === '*' || character === '?' || character === '{';
}
