/**
 * 提供 PluginHost 的稳定错误和快照隔离辅助函数。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, type ContractErrorResult, type ErrorCode, type JsonValue, type PluginManifest } from '@iar/contracts';
import type { PluginRecord } from './types.js';

/**
 * 构造 PluginHost 使用的稳定错误结果。
 *
 * @param code - 稳定错误码
 * @param message - 面向调用方的错误消息
 * @param details - 可审计错误详情
 * @returns 结构化错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function hostError(code: ErrorCode, message: string, details: Record<string, JsonValue> = {}): ContractErrorResult {
  return { schemaVersion: SCHEMA_VERSIONS.error, code, message, retryable: false, details };
}

/**
 * 深拷贝 Manifest，避免调用方通过返回值修改注册表内部能力。
 *
 * @param manifest - 待复制的 Manifest
 * @returns 与输入无共享嵌套引用的 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneManifest(manifest: PluginManifest): PluginManifest {
  return structuredClone(manifest);
}

/**
 * 返回不携带内部对象引用的注册记录副本。
 *
 * @param record - 当前注册记录
 * @returns 可安全交给调用方的记录快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneRecord(record: PluginRecord): PluginRecord {
  const functions = new Map([...record.functions.entries()].map(([functionId, item]) => [functionId, {
    definition: structuredClone(item.definition),
    operations: structuredClone(item.operations),
    handler: item.handler
  }]));
  return { ...record, manifest: cloneManifest(record.manifest), functions };
}
