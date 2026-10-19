/**
 * 复用 IAR 契约校验并隔离 PostgreSQL JSON 值的引用。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type EventEnvelope, type JsonValue, type BehaviorContext } from '@iar/contracts';
import { StorageValidationError, type RegistryEntry, type SnapshotRecord } from '@iar/storage';

/**
 * 判断值是否为可无损保存的 JSON 值，并拒绝循环引用和恶意 getter。
 *
 * @param value - 待检查的未知值
 * @param seen - 当前递归路径上的对象集合
 * @returns 是否可安全序列化
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  try {
    // null、字符串和布尔值是无需递归的合法 JSON 原子值。
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    // 数字只有在有限时才能稳定映射到 JSONB。
    if (typeof value === 'number') return Number.isFinite(value);
    // 函数、undefined、bigint 和 symbol 都不能进入 JSONB。
    if (typeof value !== 'object') return false;
    // 当前路径再次出现同一个对象表示循环引用。
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      const expectedKeys = new Set<string>(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
      const ownKeys = Reflect.ownKeys(value);
      // ownKeys 必须恰好是 length 和连续数组索引，拒绝洞、Symbol、额外属性。
      const validKeys = ownKeys.length === expectedKeys.size && ownKeys.every((key) => typeof key === 'string' && expectedKeys.has(key));
      const valid = validKeys && value.every((item) => isJsonValue(item, seen));
      seen.delete(value);
      return valid;
    }
    // 只接受普通对象，拒绝 class、Date、Map、Proxy 原型伪装。
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const ownKeys = Reflect.ownKeys(value);
    const stringKeys = Object.keys(value);
    // 普通对象的 own key 必须全部是可枚举字符串，避免 JSON.stringify 丢字段。
    const validKeys = ownKeys.length === stringKeys.length && ownKeys.every((key) => typeof key === 'string');
    const valid = validKeys && stringKeys.every((key) => isJsonValue((value as Record<string, unknown>)[key], seen));
    seen.delete(value);
    return valid;
  } catch {
    // getter、Proxy 反射或递归异常都按非法 JSON fail-closed。
    return false;
  }
}

/**
 * 校验并深拷贝 JSON 值，避免数据库返回值污染适配器结果。
 *
 * @param value - 待保存的 JSON 值
 * @returns 与输入引用隔离的副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneJsonValue<T>(value: T): T {
  // 先完成 fail-closed 校验，再进入结构化克隆，避免原始 DataCloneError 外泄。
  if (!isJsonValue(value)) throw new StorageValidationError('存储值必须是可无损 JSON 值');
  try {
    return structuredClone(value);
  } catch {
    // 结构化克隆仍可能被 Proxy 等恶意对象拒绝，统一返回校验错误。
    throw new StorageValidationError('存储值必须是可无损 JSON 值');
  }
}

/**
 * 校验并深拷贝事件。
 *
 * @param event - 待持久化的事件事实
 * @returns 校验后的事件副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneEvent(event: EventEnvelope): EventEnvelope {
  try {
    // 事件结构不符合公共契约时立即拒绝，避免非法 payload 进入数据库。
    if (!validateContract('event', event).ok) throw new StorageValidationError('EventEnvelope 契约无效');
  } catch {
    // 契约校验器或恶意输入抛出原始异常时统一转换为稳定校验错误。
    throw new StorageValidationError('EventEnvelope 契约无效');
  }
  // 事件主键必须在进入参数化 SQL 前完成长度和控制字符校验。
  assertIdentifier(event.eventId, 'eventId');
  assertIdentifier(event.runId, 'runId');
  return cloneJsonValue(event);
}

/**
 * 校验并深拷贝快照。
 *
 * @param snapshot - 待持久化的行为上下文快照
 * @returns 校验后的快照副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneSnapshot(snapshot: SnapshotRecord): SnapshotRecord {
  // null、数组、负数和非安全整数 revision 都不能表示可恢复快照。
  if (!isRecord(snapshot) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new StorageValidationError('快照 revision 必须是非负安全整数');
  }
  // runId/eventId 是快照事实来源的边界标识，必须拒绝空值和控制字符。
  assertIdentifier(snapshot.runId, 'runId');
  assertIdentifier(snapshot.eventId, 'eventId');
  try {
    // 行为上下文契约失败时拒绝持久化，避免产生不可重放的 snapshot。
    if (!validateContract('behaviorContext', snapshot.context).ok) throw new StorageValidationError('BehaviorContext 契约无效');
  } catch {
    // 校验器异常也按 fail-closed 处理，不把内部错误文本交给调用方。
    throw new StorageValidationError('BehaviorContext 契约无效');
  }
  return cloneJsonValue(snapshot);
}

/**
 * 以最小类型约束解析数据库返回的行为上下文。
 *
 * @param value - PostgreSQL JSONB 返回值
 * @returns 与数据库引用隔离的行为上下文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function parseContext(value: unknown): BehaviorContext {
  return cloneJsonValue(value) as BehaviorContext;
}

/**
 * 校验数据库查询中的租户、运行和注册表标识。
 *
 * @param value - 外部或数据库边界传入的标识
 * @param field - 错误消息中的字段名
 * @param maxLength - 允许的最大长度
 * @returns 无返回值；无效标识抛出 StorageValidationError
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function assertIdentifier(value: unknown, field: string, maxLength = 256): asserts value is string {
  // 空值、超长值和控制字符可能破坏租户/业务键边界，统一拒绝。
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StorageValidationError(`${field} 无效`);
  }
}

/**
 * 仅接受普通对象，避免 malformed 快照触发原始 TypeError。
 *
 * @param value - 待判断的未知值
 * @returns 是否为非数组普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
