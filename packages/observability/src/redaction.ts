/**
 * 在结构化观测写入前执行递归脱敏和 JSON 边界收敛。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { RedactionOptions } from './types.js';

const REDACTED = '[REDACTED]';
const UNSAFE_REDACTED = '[UNSAFE_REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const SENSITIVE_KEY = /(?:api.?key|authorization|raw.?prompt|raw.?user.?input|password|token|secret|credential|cookie|private.?key)/iu;

/** @param fields - 未脱敏字段 @param sensitivePaths - 额外敏感路径 @returns 可安全写入的 JSON 字段 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function redactFields(fields: Record<string, unknown> | undefined, sensitivePaths: readonly string[] = [], options: RedactionOptions = {}): Record<string, JsonValue> {
  try {
    const budget = { nodes: 0, maxNodes: options.maxNodes ?? 4096, maxDepth: options.maxDepth ?? 32 };
    const value = redactValue(fields ?? {}, [], new Set(), new Set(sensitivePaths), budget);
    return isJsonObject(value) ? value : { value: UNSAFE_REDACTED };
  } catch {
    return { value: UNSAFE_REDACTED };
  }
}

/** @param value - 未信任值 @param path - 当前字段路径 @param seen - 当前递归链对象 @param sensitivePaths - 额外敏感路径 @returns 脱敏后的 JSON 值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function redactValue(value: unknown, path: readonly string[], seen: Set<object>, sensitivePaths: ReadonlySet<string>, budget: { nodes: number; maxNodes: number; maxDepth: number }): JsonValue {
  if (isSensitiveKey(path.at(-1) ?? '', path, sensitivePaths)) return REDACTED;
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes || path.length > budget.maxDepth) return TRUNCATED;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNSAFE_REDACTED;
  try {
    if (typeof value !== 'object' || seen.has(value) || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value))) return UNSAFE_REDACTED;
    seen.add(value);
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (budget.nodes >= budget.maxNodes) { output.push(TRUNCATED); break; }
        output.push(redactValue(value[index], [...path, String(index)], seen, sensitivePaths, budget));
      }
      return output;
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (budget.nodes >= budget.maxNodes) { output._truncated = TRUNCATED; break; }
      output[key] = redactValue(item, [...path, key], seen, sensitivePaths, budget);
    }
    return output;
  } catch {
    return UNSAFE_REDACTED;
  } finally {
    if (typeof value === 'object' && value !== null) seen.delete(value);
  }
}

/** @param key - 当前字段名 @param path - 当前字段路径 @param sensitivePaths - 额外敏感路径 @returns 是否应脱敏 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSensitiveKey(key: string, path: readonly string[], sensitivePaths: ReadonlySet<string>): boolean {
  return SENSITIVE_KEY.test(key) || sensitivePaths.has(path.join('.'));
}

/** @param value - 未知 JSON 值 @returns 是否为普通 JSON 对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
