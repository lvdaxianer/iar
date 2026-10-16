/**
 * 对 executor 外部消息执行 JSON、标识、能力和资源预算校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import { EXECUTOR_PROTOCOL_VERSION, type ExecutorError, type ExecutorOptions, type ExecutorRequest } from './types.js';

/*
 * 校验顺序固定为对象、协议、标识、资源、数组和 JSON。
 * 任何失败都返回同一个 invalid_request 语义，不回显原值。
 * 协议版本错误不能触发 handler。
 * 空标识不能进入日志、Map key 或路径。
 * timeout、输入和输出预算必须是正安全整数。
 * 默认预算仍然有限，防止遗漏配置造成无限资源。
 * capabilities 采用精确匹配，不支持 wildcard。
 * credentialRefs 采用稳定标识符，不接受路径或表达式。
 * 数组元素必须唯一，避免重复执行或重复取密钥。
 * 普通对象检查拒绝继承属性伪造字段。
 * JSON 数字必须 finite，避免序列化差异。
 * normalizeOptions 在 executor 构造阶段拒绝坏配置。
 * validateRequest 在每次 execute 前再次执行。
 * executorError 不包含异常 message、input 或 secret。
 * 该模块不依赖 Workflow、PluginHost 或真实网络。
 * isRecord 在读取字段前排除 null 和数组。
 * isJsonValue 递归检查数组元素和对象属性。
 * 字节预算由 core 使用相同 JSON 序列化规则计算。
 * 配置错误在构造阶段抛出，不进入异步执行路径。
 * request 错误在 response 中只保留稳定 code/message。
 * credential ref 的正则不允许目录分隔符。
 * capability 列表重复会被拒绝，避免重复授权语义。
 * default capability 只有 plugin.execute。
 * caller 可以提供更小的资源预算，但不能提供无限预算。
 * 这一层是所有 mode 共用的 fail-closed 起点。
 * 超深对象在遍历预算内被稳定拒绝。
 * 重复对象引用按非 JSON 图拒绝。
 * 此处不调用任何用户 handler。
 * 所有公开校验函数都可独立测试。
 * 配置校验不接受 NaN、Infinity 或负数。
 */

/** 默认资源上限保持有限，避免未配置时退化为无限制。 */
export const DEFAULT_EXECUTOR_LIMITS = { maxTimeoutMs: 300_000, maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576 } as const;

/** @param code - 稳定错误码 @param message - 安全错误消息 @param retryable - 是否可重试 @returns 稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function executorError(code: string, message: string, retryable = false): ExecutorError {
  return { code, message, retryable };
}

/** @param request - 未知 executor 请求 @returns 稳定错误或 null @author lvdaxianer@yeah.net @date 2026-10-17 */
export function validateRequest(request: ExecutorRequest): ExecutorError | null {
  try {
    if (!isRecord(request) || request.protocolVersion !== EXECUTOR_PROTOCOL_VERSION) return executorError('executor.invalid_request', 'Executor 请求无效');
    if (![request.requestId, request.traceId, request.tenantId, request.pluginId, request.pluginVersion].every(isBoundedString)) return executorError('executor.invalid_request', 'Executor 请求无效');
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || !isJsonValue(request.input)) return executorError('executor.invalid_request', 'Executor 请求无效');
    if (!boundedUniqueStrings(request.capabilities) || !boundedUniqueStrings(request.credentialRefs) || request.credentialRefs.some((ref) => !isCredentialRef(ref))) return executorError('executor.invalid_request', 'Executor 请求无效');
    return null;
  } catch {
    return executorError('executor.invalid_request', 'Executor 请求无效');
  }
}

/** @param options - executor 配置 @returns 规范化配置 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function normalizeOptions(options: ExecutorOptions): Required<Pick<ExecutorOptions, 'version' | 'maxTimeoutMs' | 'maxInputBytes' | 'maxOutputBytes' | 'allowedCapabilities'>> & ExecutorOptions {
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_EXECUTOR_LIMITS.maxTimeoutMs;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_EXECUTOR_LIMITS.maxInputBytes;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_EXECUTOR_LIMITS.maxOutputBytes;
  const allowedCapabilities = [...(options.allowedCapabilities ?? ['plugin.execute'])];
  if (!isBoundedString(options.version) || ![maxTimeoutMs, maxInputBytes, maxOutputBytes].every((value) => Number.isSafeInteger(value) && value > 0) || !boundedUniqueStrings(allowedCapabilities) || allowedCapabilities.some((capability) => capability === '*')) throw new TypeError('Executor 配置无效');
  return { ...options, maxTimeoutMs, maxInputBytes, maxOutputBytes, allowedCapabilities };
}

/** @param value - 候选字符串列表 @returns 是否有限且唯一 @author lvdaxianer@yeah.net @date 2026-10-17 */
function boundedUniqueStrings(value: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.every(isBoundedString) && new Set(value).size === value.length;
}

/** @param value - 未知值 @returns 是否为有界字符串 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @param value - 凭据引用 @returns 是否为稳定标识符 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isCredentialRef(value: string): boolean {
  return /^[A-Za-z0-9._:-]+$/u.test(value);
}

/** @param value - 未知值 @returns 是否为有界 JSON 值 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function isJsonValue(value: unknown): value is JsonValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > 10_000 || current.depth > 32) return false;
    if (current.value === null || typeof current.value === 'string' || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') { if (!Number.isFinite(current.value)) return false; continue; }
    if (typeof current.value !== 'object' || seen.has(current.value)) return false;
    seen.add(current.value);
    if (Array.isArray(current.value)) { current.value.forEach((item) => pending.push({ value: item, depth: current.depth + 1 })); continue; }
    if (!isRecord(current.value)) return false;
    Object.values(current.value).forEach((item) => pending.push({ value: item, depth: current.depth + 1 }));
  }
  return true;
}

/** @param value - 未知值 @returns 是否为普通对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
