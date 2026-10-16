/**
 * 定义跨语言 control-plane 的 JSON-safe、版本化 ABI 类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { PluginManifest } from '@iar/contracts';

/** 当前 control-plane 协议版本。 */
export const CONTROL_PLANE_PROTOCOL_VERSION = 'iar.control-plane/v1' as const;

/** 当前 control-plane 请求 Schema 版本。 */
export const CONTROL_PLANE_SCHEMA_VERSION = 'iar.control-plane-request/v1' as const;

/** ABI 兼容性检查使用的协议版本集合。 */
export type AbiVersion = typeof CONTROL_PLANE_PROTOCOL_VERSION;

/** control-plane 支持的有限操作集合。 */
export type ControlPlaneOperation =
  | 'plugin.install'
  | 'plugin.upgrade'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'plugin.rollback'
  | 'plugin.inspect'
  | 'plugin.audit';

/** 经过认证的 tenant、actor 和 environment 上下文。 */
export type ControlPlaneContext = {
  /** 认证后的租户稳定标识。 */
  tenantId: string;
  /** 发起操作的主体稳定标识。 */
  actorId: string;
  /** 策略和审计使用的环境标识。 */
  environment: string;
};

/** control-plane 请求的 JSON-safe 外壳。 */
export type ControlPlaneRequest = {
  /** 协议版本，禁止调用方降级或升级解释。 */
  protocolVersion: AbiVersion;
  /** 幂等和审计使用的请求标识。 */
  requestId: string;
  /** 贯穿 control-plane 和 runtime 的追踪标识。 */
  traceId: string;
  /** 不可由 payload 覆盖的认证上下文。 */
  context: ControlPlaneContext;
  /** 有限的 lifecycle/control 操作。 */
  operation: ControlPlaneOperation;
  /** 按 operation 收敛的 JSON-safe payload。 */
  payload: Record<string, unknown>;
};

/** control-plane 公开的稳定错误码。 */
export type ControlPlaneErrorCode =
  | 'abi_input_invalid'
  | 'abi_version_incompatible'
  | 'manifest_invalid'
  | 'schema_invalid'
  | 'tenant_access_denied'
  | 'policy_denied'
  | 'capability_approval_required'
  | 'plugin_not_found'
  | 'operation_failed';

/** ABI 校验成功或稳定拒绝的结果。 */
export type AbiResult<T> =
  // 成功只返回通过校验的深拷贝。
  | { ok: true; value: T }
  // 失败只返回稳定错误码，不携带原始异常。
  | { ok: false; reasonCode: ControlPlaneErrorCode; details?: Record<string, string | string[]> };

/** control-plane 成功/失败响应，字段可直接跨语言 JSON 序列化。 */
export type ControlPlaneResponse<T = unknown> = {
  /** 响应协议版本。 */
  protocolVersion: AbiVersion;
  /** 响应 Schema 版本。 */
  schemaVersion: typeof CONTROL_PLANE_SCHEMA_VERSION;
  /** 原请求标识。 */
  requestId: string;
  /** 原追踪标识。 */
  traceId: string;
  /** 原租户标识。 */
  tenantId: string;
  /** 成功时的脱敏数据。 */
  data: T | null;
  /** 失败时的稳定错误。 */
  error: { code: ControlPlaneErrorCode; message: string; retryable: boolean } | null;
};

/** ABI compatibility matrix 的显式版本行。 */
export type AbiCompatibilityMatrix = ReadonlyMap<string, readonly string[]>;

/** install/upgrade payload 中可被 ABI 直接校验的 Manifest 载荷。 */
export type ManifestPayload = { manifest: PluginManifest };

// 线类型不包含函数、类实例或传输层句柄。
// 所有标识都会在请求进入 runtime 前校验。
// 本包是非 TypeScript 客户端共享的 wire source。
// 协议演进应新增矩阵行，而不是扩大当前联合类型。
// 错误详情保持有界且 JSON-safe。
// 消费方必须在 wire 上保留这些字段名。
// 新协议必须经过审查后加入 compatibility matrix。
