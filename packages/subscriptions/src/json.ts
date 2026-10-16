/**
 * 提供循环安全的可重放 JSON 运行时校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */

/**
 * 判断值是否为有限、非循环且无稀疏洞的 JSON 值。
 *
 * @param value - 未信任输入
 * @returns 是否满足 JSON 运行时边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isJsonValue(value: unknown): boolean {
  return visitJson(value, new WeakSet<object>());
}

/**
 * 递归检查 JSON 值，并在进入对象前拒绝循环引用。
 *
 * @param value - 当前值
 * @param seen - 当前递归路径上的对象集合
 * @returns 是否为合法 JSON 值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function visitJson(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!isPlainObject(value) && !Array.isArray(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? visitArray(value, seen) : visitObject(value, seen);
  seen.delete(value);
  return valid;
}

/**
 * 检查数组成员存在且都是合法 JSON，拒绝稀疏数组。
 *
 * @param value - 待检查数组
 * @param seen - 当前递归路径对象集合
 * @returns 是否合法
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function visitArray(value: unknown[], seen: WeakSet<object>): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index) || !visitJson(value[index], seen)) return false;
  }
  return true;
}

/**
 * 检查普通对象的所有字段。
 *
 * @param value - 待检查对象
 * @param seen - 当前递归路径对象集合
 * @returns 是否合法
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function visitObject(value: Record<string, unknown>, seen: WeakSet<object>): boolean {
  return Object.values(value).every((item) => visitJson(item, seen));
}

/**
 * 判断值是否为普通 JSON 对象。
 *
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
