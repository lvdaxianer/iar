/**
 * 实现 control-plane ABI 的 allow-list、JSON-safe 和 Manifest 校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validatePluginManifest } from '../validation.js';
import { CONTROL_PLANE_PROTOCOL_VERSION, type AbiResult, type ControlPlaneContext, type ControlPlaneOperation, type ControlPlaneRequest } from './types.js';

const OPERATIONS: readonly ControlPlaneOperation[] = ['plugin.install', 'plugin.upgrade', 'plugin.enable', 'plugin.disable', 'plugin.rollback', 'plugin.inspect', 'plugin.audit'];
const REQUEST_KEYS = ['context', 'operation', 'payload', 'protocolVersion', 'requestId', 'traceId'];
const CONTEXT_KEYS = ['actorId', 'environment', 'tenantId'];

/**
 * 校验 control-plane 请求并返回结构化安全副本。
 * @param input - 未信任的跨语言输入
 * @returns 通过 ABI 校验的请求或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validateControlPlaneRequest(input: unknown): AbiResult<ControlPlaneRequest> {
  try {
    if (!isPlainRecord(input) || !hasExactKeys(input, REQUEST_KEYS)) return { ok: false, reasonCode: 'abi_input_invalid' }; // 请求外壳必须是精确 allow-list。
    if (input.protocolVersion !== CONTROL_PLANE_PROTOCOL_VERSION) return { ok: false, reasonCode: 'abi_version_incompatible' }; // 不隐式降级协议。
    if (!isIdentifier(input.requestId) || !isIdentifier(input.traceId)) return { ok: false, reasonCode: 'abi_input_invalid' }; // trace/request 标识必须可审计。
    const context = validateContext(input.context);
    if (!context.ok) return context;
    if (!OPERATIONS.includes(input.operation as ControlPlaneOperation)) return { ok: false, reasonCode: 'abi_input_invalid' }; // 操作集合固定且跨语言一致。
    const payload = validatePayload(input.operation as ControlPlaneOperation, input.payload);
    if (!payload.ok) return payload;
    if (!isJsonSafe(input)) return { ok: false, reasonCode: 'abi_input_invalid' };
    return { ok: true, value: structuredClone({ ...input, context: context.value, payload: payload.value }) as ControlPlaneRequest };
  } catch {
    return { ok: false, reasonCode: 'abi_input_invalid' };
  }
}

/**
 * 检查两个协议版本是否在显式 compatibility matrix 中可互操作。
 * @param localVersion - 当前 control-plane 支持的版本
 * @param remoteVersion - 远端声明的版本
 * @returns 兼容成功或稳定版本拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function checkAbiCompatibility(localVersion: string, remoteVersion: string): AbiResult<true> {
  const matrix = new Map<string, readonly string[]>([[CONTROL_PLANE_PROTOCOL_VERSION, [CONTROL_PLANE_PROTOCOL_VERSION]]]);
  return matrix.get(localVersion)?.includes(remoteVersion) ? { ok: true, value: true } : { ok: false, reasonCode: 'abi_version_incompatible' };
}

/** 校验请求上下文的精确字段和边界标识。 */
function validateContext(input: unknown): AbiResult<ControlPlaneContext> {
  if (!isPlainRecord(input) || !hasExactKeys(input, CONTEXT_KEYS)) return { ok: false, reasonCode: 'abi_input_invalid' };
  if (!isIdentifier(input.tenantId) || !isIdentifier(input.actorId) || !isIdentifier(input.environment)) return { ok: false, reasonCode: 'abi_input_invalid' };
  return { ok: true, value: { tenantId: input.tenantId, actorId: input.actorId, environment: input.environment } };
}

/** 校验按操作收敛的 payload 字段和 Manifest Schema。 */
function validatePayload(operation: ControlPlaneOperation, input: unknown): AbiResult<Record<string, unknown>> {
  if (!isPlainRecord(input)) return { ok: false, reasonCode: 'abi_input_invalid' }; // payload 不接受数组或类实例。
  const keys = Object.keys(input);
  if (['plugin.inspect', 'plugin.enable', 'plugin.disable', 'plugin.rollback'].includes(operation)) {
    if (!hasExactKeys(input, ['pluginId']) || !isIdentifier(input.pluginId)) return { ok: false, reasonCode: 'abi_input_invalid' }; // 生命周期操作只能定位一个 plugin。
    return { ok: true, value: { pluginId: input.pluginId } };
  }
  if (operation === 'plugin.audit') {
    if (keys.length > 1 || (keys.length === 1 && !keys.includes('pluginId')) || (input.pluginId !== undefined && !isIdentifier(input.pluginId))) return { ok: false, reasonCode: 'abi_input_invalid' }; // audit 可选 pluginId 过滤。
    return { ok: true, value: input };
  }
  const allowed = operation === 'plugin.upgrade' ? ['approval', 'artifact'] : ['artifact'];
  if (!isPlainRecord(input.artifact) || keys.some((key) => !allowed.includes(key)) || !keys.includes('artifact')) return { ok: false, reasonCode: 'abi_input_invalid' }; // install/upgrade 统一消费 artifact。
  if (input.approval !== undefined && !isPlainRecord(input.approval)) return { ok: false, reasonCode: 'abi_input_invalid' }; // approval 仍由分发层绑定完整集合。
  if (!isPlainRecord(input.artifact.manifest)) return { ok: false, reasonCode: 'manifest_invalid' }; // artifact 必须携带普通 Manifest 对象。
  const manifest = validatePluginManifest(input.artifact.manifest);
  if (!manifest.ok) return { ok: false, reasonCode: 'manifest_invalid' }; // ABI 复用 contracts，不复制 Manifest 规则。
  return { ok: true, value: input };
}

/**
 * 判断对象是否为普通 JSON record，拒绝原型注入。
 * @param value - 待检查的未知值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 判断对象 own keys 是否与 ABI allow-list 完全一致。
 * @param value - 待检查的对象
 * @param expected - 允许的字段集合
 * @returns 是否精确匹配
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

/**
 * 校验可跨语言传输的有限标识符。
 * @param value - 待检查的标识
 * @returns 是否满足长度和字符边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * 用递归路径集合检测循环、BigInt、函数和其他非 ABI 值。
 * @param value - 待检查的 JSON-like 值
 * @param seen - 当前递归路径上的对象集合
 * @returns 是否可安全跨语言传输
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isJsonSafe(value: unknown, path = new Set<object>(), budget: JsonBudget = { depth: 0, nodes: 0, bytes: 0 }): boolean {
  if (budget.depth > 32 || ++budget.nodes > 4096) return false; // 限制恶意深度和节点数量。
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); return budget.bytes <= 262144; }
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || path.has(value) || (!isPlainRecord(value) && !Array.isArray(value))) return false;
  path.add(value);
  const next = { depth: budget.depth + 1, nodes: budget.nodes, bytes: budget.bytes };
  const values = Array.isArray(value) ? value : Object.values(value);
  const safe = values.every((entry) => isJsonSafe(entry, path, next));
  path.delete(value);
  budget.nodes = next.nodes;
  budget.bytes = next.bytes;
  return safe;
}

/** JSON-safe 检查的资源预算，防止跨语言边界被超大输入拖垮。 */
type JsonBudget = { depth: number; nodes: number; bytes: number };

// 递归结束后移除对象，允许共享引用并继续拒绝循环引用。
// 校验器不会修改调用方的对象图。
// 深度、节点和字节预算共同限制恶意输入资源。
// 预算超限统一返回 ABI 输入错误。
// 普通对象之外的实例不会进入跨语言协议。
// Manifest 校验发生在资源检查之前，保持错误归因稳定。
