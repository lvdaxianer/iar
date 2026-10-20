/**
 * 提供跨内存和 SQLite 适配器一致的 JSON 值校验与深拷贝。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type EventEnvelope, type JsonValue } from '@iar/contracts';
import { StorageValidationError, type SnapshotRecord } from './types.js';

/** 判断值是否能无损表示为 JSON。 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    return keys.length === value.length && keys.every((key, index) => key === String(index)) && value.every(isJsonValue);
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(value);
  const stringKeys = Object.keys(value);
  if (ownKeys.length !== stringKeys.length) return false;
  return stringKeys.every((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && isJsonValue(record[key]));
}

/** 校验并深拷贝 JSON 记录，拒绝 undefined、BigInt、函数和非有限数字。 */
export function cloneJsonValue<T>(value: T): T {
  if (!isJsonValue(value)) throw new StorageValidationError('存储值必须是可无损 JSON 值');
  return structuredClone(value);
}

/** 校验并深拷贝 EventEnvelope，防止事实源写入无效事件。 */
export function cloneEvent(event: EventEnvelope): EventEnvelope {
  const result = validateContract('event', event);
  if (!result.ok) throw new StorageValidationError('EventEnvelope 契约无效');
  return cloneJsonValue(event);
}

/** 校验并深拷贝带 revision 的行为快照。 */
export function cloneSnapshot(snapshot: SnapshotRecord): SnapshotRecord {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new StorageValidationError('快照 revision 必须是非负安全整数');
  }
  const result = validateContract('behaviorContext', snapshot.context);
  if (!result.ok) throw new StorageValidationError('BehaviorContext 契约无效');
  return cloneJsonValue(snapshot);
}
