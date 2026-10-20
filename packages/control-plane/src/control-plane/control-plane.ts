/**
 * 实现 tenant-bound 的远程插件 control plane，不复制 Policy Gate 或 PluginHost 语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateControlPlaneRequest, type ControlPlaneOperation, type ControlPlaneRequest, type ControlPlaneResponse } from '@iar/contracts';
import { RemotePluginDistributor } from '../distribution/distributor.js';
import type { DistributionRecord, SignedPluginArtifact } from '../distribution/types.js';
import type { PluginRecord } from '@iar/plugins';
import type { ControlPlaneAuditRecord, ControlPlanePolicyDecision, TenantControlPlane, TenantControlPlaneOptions, TenantRuntime } from './types.js';

/**
 * 创建带租户隔离、授权前置和安全审计的 control plane。
 * @param options - Host、signer 和策略边界
 * @returns tenant-bound control-plane API
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createTenantControlPlane(options: TenantControlPlaneOptions): TenantControlPlane {
  return new TenantControlPlaneService(options);
}

/** 管理 tenant runtime、插件所有权索引和 control-plane 审计。 */
class TenantControlPlaneService implements TenantControlPlane {
  private readonly runtimes = new Map<string, TenantRuntimeState>();
  private readonly knownPlugins = new Map<string, Set<string>>();
  private readonly tenantAudits = new Map<string, ControlPlaneAuditRecord[]>();
  private readonly options: TenantControlPlaneOptions;

  /**
   * 保存显式依赖，不提前创建任何 tenant Host。
   * @param options - tenant runtime、signer 和策略依赖
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: TenantControlPlaneOptions) {
    this.options = options;
  }

  /**
   * 校验、授权并执行一个 ABI 请求。
   * @param input - 未信任跨语言输入
   * @returns 带稳定错误和安全数据的响应
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async request<T = unknown>(input: unknown): Promise<ControlPlaneResponse<T>> {
    const validated = validateControlPlaneRequest(input);
    if (!validated.ok) return failure<T>('', '', '', validated.reasonCode);
    const request = validated.value;
    try {
      const decision = await this.options.authorize(request.context, request.operation, request.payload);
      if (!decision.allowed) return this.reject(request, decision); // Policy Gate 失败时绝不创建 Host。
      const pluginId = pluginIdOf(request);
      if (this.foreignTenant(pluginId, request.context.tenantId, request.operation)) return this.reject(request, { allowed: false, reasonCode: 'policy_denied' }, 'tenant_access_denied'); // 跨租户访问在 runtime 前拒绝。
      const state = this.runtime(request.context.tenantId); // 只有授权且非跨租户请求才能接触 Host。
      const result = await this.dispatch(state, request);
      return result.ok ? this.accept(request, pluginId ?? 'unknown', result.value as T, versionOf(result.value)) : this.reject(request, { allowed: false }, result.reasonCode);
    } catch {
      return this.reject(request, { allowed: false }, 'operation_failed');
    }
  }

  /** 为已授权 tenant 延迟创建独占 runtime。 */
  private runtime(tenantId: string): TenantRuntimeState {
    const existing = this.runtimes.get(tenantId);
    if (existing) return existing; // 同一 tenant 复用自己的 runtime。
    const runtime = this.options.hostFactory(tenantId); // 工厂不接收可覆盖的请求 tenant 字段。
    const distributionOptions = { host: runtime.host, trustedSigners: this.options.trustedSigners, compatibility: runtime.compatibility };
    const state: TenantRuntimeState = { ...runtime, distributor: new RemotePluginDistributor(runtime.store === undefined ? distributionOptions : { ...distributionOptions, store: runtime.store }), audit: this.audit(tenantId) };
    this.runtimes.set(tenantId, state);
    return state;
  }

  /** 分发有限的插件生命周期操作，并仅返回脱敏数据。 */
  private dispatch(state: TenantRuntimeState, request: ControlPlaneRequest): OperationResult {
    const payload = request.payload;
    if (request.operation === 'plugin.install') return this.distribution(state, request, state.distributor.install(payload.artifact)); // 签名和 Manifest 由分发器校验。
    if (request.operation === 'plugin.upgrade') return this.distribution(state, request, state.distributor.upgrade(payload.artifact, payload.approval as never)); // capability 审批不在 ABI 层伪造。
    if (request.operation === 'plugin.rollback') return this.distribution(state, request, state.distributor.rollback(String(payload.pluginId))); // rollback 使用 immutable history。
    if (request.operation === 'plugin.inspect') return this.inspect(state, String(payload.pluginId)); // inspect 只返回安全快照。
    if (request.operation === 'plugin.audit') return { ok: true, value: { records: structuredClone(state.audit) } }; // 审计按 tenant 过滤。
    const pluginId = String(payload.pluginId);
    const result = request.operation === 'plugin.enable' ? state.host.enable(pluginId) : state.host.disable(pluginId);
    return result.ok ? { ok: true, value: safeRecord(result.value) } : { ok: false, reasonCode: result.error.code === 'plugin.unavailable' ? 'plugin_not_found' : 'operation_failed' }; // 不透传 Host 错误详情。
  }

  /** 执行安装、升级或回滚，并更新 tenant 所有权索引。 */
  private distribution(state: TenantRuntimeState, request: ControlPlaneRequest, result: ReturnType<RemotePluginDistributor['install']>): OperationResult {
    if (!result.ok) return result; // 分发器拒绝时不记录 accepted ownership。
    const record = result.value;
    this.remember(request.context.tenantId, record.manifest.pluginId);
    return { ok: true, value: safeRecord(record) };
  }

  /** 返回当前 tenant 的安全插件快照。 */
  private inspect(state: TenantRuntimeState, pluginId: string): OperationResult {
    const record = state.host.get(pluginId) ?? state.distributor.current(pluginId);
    return record ? { ok: true, value: safeRecord(record) } : { ok: false, reasonCode: 'plugin_not_found' }; // 当前 tenant 不存在即稳定 404 语义。
  }

  /** 判断操作是否试图访问另一个 tenant 已知的插件。 */
  private foreignTenant(pluginId: string | undefined, tenantId: string, operation: ControlPlaneOperation): boolean {
    if (!pluginId || operation === 'plugin.install') return false; // install 可在多个 tenant 独立拥有同一 plugin。
    const owners = this.knownPlugins.get(pluginId) ?? new Set<string>();
    if (operation === 'plugin.upgrade') return owners.size > 0 && !owners.has(tenantId); // upgrade 必须由已拥有该 plugin 的 tenant 发起。
    return [...owners].some((owner) => owner !== tenantId);
  }

  /** 记录 tenant 级审计并返回成功响应。 */
  private accept<T>(request: ControlPlaneRequest, pluginId: string, data: T, version?: string): ControlPlaneResponse<T> {
    this.audit(request.context.tenantId).push({ tenantId: request.context.tenantId, requestId: request.requestId, traceId: request.traceId, operation: request.operation, pluginId, result: 'accepted', ...(version === undefined ? {} : { version }), occurredAt: new Date().toISOString() });
    return success(request, data);
  }

  /** 记录稳定拒绝并隐藏策略或 Host 的底层异常。 */
  private reject(request: ControlPlaneRequest, decision: ControlPlanePolicyDecision, reasonCode: string = decision.reasonCode ?? 'policy_denied'): ControlPlaneResponse<never> {
    this.audit(request.context.tenantId).push({ tenantId: request.context.tenantId, requestId: request.requestId, traceId: request.traceId, operation: request.operation, pluginId: pluginIdOf(request) ?? 'unknown', result: 'rejected', reasonCode, occurredAt: new Date().toISOString() });
    return failure(request.requestId, request.traceId, request.context.tenantId, reasonCode);
  }

  /** 记录一个 tenant 曾经成功管理过的 pluginId。 */
  private remember(tenantId: string, pluginId: string): void {
    const owners = this.knownPlugins.get(pluginId) ?? new Set<string>();
    owners.add(tenantId);
    this.knownPlugins.set(pluginId, owners);
  }

  /** 返回 tenant 专属且可安全追加的审计数组。 */
  /**
   * 返回 tenant 专属且可安全追加的审计数组。
   * @param tenantId - 租户稳定标识
   * @returns tenant 专属审计数组
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private audit(tenantId: string): ControlPlaneAuditRecord[] {
    const existing = this.tenantAudits.get(tenantId);
    if (existing) return existing;
    const created: ControlPlaneAuditRecord[] = [];
    this.tenantAudits.set(tenantId, created);
    return created;
  }
}

type TenantRuntimeState = TenantRuntime & { distributor: RemotePluginDistributor; audit: ControlPlaneAuditRecord[] };
type OperationResult = { ok: true; value: unknown } | { ok: false; reasonCode: string };

/**
 * 从请求 payload 安全取得 pluginId 或 artifact Manifest pluginId。
 * @param request - 已通过 ABI 校验的请求
 * @returns pluginId 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function pluginIdOf(request: ControlPlaneRequest): string | undefined {
  const direct = request.payload.pluginId;
  if (typeof direct === 'string') return direct;
  const artifact = request.payload.artifact;
  if (typeof artifact === 'object' && artifact !== null && typeof (artifact as { manifest?: { pluginId?: unknown } }).manifest?.pluginId === 'string') return (artifact as { manifest: { pluginId: string } }).manifest.pluginId;
  return undefined;
}

/**
 * 从安全数据中提取版本用于 control-plane 审计。
 * @param value - 脱敏操作结果
 * @returns Manifest 版本或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function versionOf(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && typeof (value as { manifest?: { version?: unknown } }).manifest?.version === 'string' ? (value as { manifest: { version: string } }).manifest.version : undefined;
}

/**
 * 移除签名正文，只返回 Manifest 和生命周期状态。
 * @param value - distribution 或 Host 记录
 * @returns 可跨 ABI 返回的安全 record
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function safeRecord(value: DistributionRecord | PluginRecord): Record<string, unknown> {
  return { pluginId: value.manifest.pluginId, version: value.manifest.version, state: value.state, manifest: structuredClone(value.manifest) };
}

/**
 * 构造成功的版本化 ABI 响应。
 * @param request - 原始已校验请求
 * @param data - 脱敏业务数据
 * @returns 版本化成功响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function success<T>(request: ControlPlaneRequest, data: T): ControlPlaneResponse<T> {
  return { protocolVersion: 'iar.control-plane/v1', schemaVersion: 'iar.control-plane-request/v1', requestId: request.requestId, traceId: request.traceId, tenantId: request.context.tenantId, data, error: null };
}

/**
 * 构造不暴露原始异常或 payload 的失败响应。
 * @param requestId - 请求标识
 * @param traceId - 追踪标识
 * @param tenantId - 租户标识
 * @param code - 稳定错误码
 * @returns 版本化失败响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function failure<T>(requestId: string, traceId: string, tenantId: string, code: string): ControlPlaneResponse<T> {
  return { protocolVersion: 'iar.control-plane/v1', schemaVersion: 'iar.control-plane-request/v1', requestId, traceId, tenantId, data: null, error: { code: code as ControlPlaneResponse['error'] extends { code: infer C } | null ? C : never, message: 'control-plane operation rejected', retryable: false } };
}

// 策略拒绝路径刻意不创建 runtime。
// PluginHost 仍是唯一生命周期状态机。
// 远程分发仍是唯一签名、版本和审批边界。
// control-plane 记录只是投影数据，不是授权来源。
