/**
 * 定义 tenant-bound control plane 的注入边界、策略决定和安全审计。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ControlPlaneContext, ControlPlaneOperation, ControlPlaneRequest, ControlPlaneResponse } from '@iar/contracts';
import type { DistributionCompatibility, DistributionStore, TrustedSigner } from '../distribution/types.js';
import type { PluginHost } from '@iar/plugins';

/** 对外复用的 control-plane 请求类型别名。 */
export type TenantControlPlaneRequest = ControlPlaneRequest;

/** 对外复用的 control-plane 响应类型别名。 */
export type TenantControlPlaneResponse<T = unknown> = ControlPlaneResponse<T>;

/** Policy Gate 注入的最小稳定决定。 */
export type ControlPlanePolicyDecision = {
  /** 是否允许继续访问 tenant runtime。 */
  allowed: boolean;
  /** 策略拒绝的稳定原因。 */
  reasonCode?: 'policy_denied' | 'capability_approval_required';
};

/** 每个 tenant 独占的 Host、分发器和审计 store。 */
export type TenantRuntime = {
  /** 该 tenant 独占的 PluginHost。 */
  host: PluginHost;
  /** 该 tenant 的 Host API 和依赖视图。 */
  compatibility: DistributionCompatibility;
  /** 可选的 tenant-bound distribution store。 */
  store?: DistributionStore;
};

/** control-plane 的 tenant runtime 工厂。 */
export type TenantRuntimeFactory = (tenantId: string) => TenantRuntime;

/** control-plane 策略回调，不承担 Manifest 或生命周期语义。 */
export type ControlPlaneAuthorizer = (context: ControlPlaneContext, operation: ControlPlaneOperation, payload: Record<string, unknown>) => ControlPlanePolicyDecision | Promise<ControlPlanePolicyDecision>;

/** 创建 tenant-bound control plane 所需的显式依赖。 */
export type TenantControlPlaneOptions = {
  /** 远程 artifact signer 信任映射。 */
  trustedSigners: ReadonlyMap<string, TrustedSigner>;
  /** 只在授权通过后调用的 tenant runtime 工厂。 */
  hostFactory: TenantRuntimeFactory;
  /** 外部 Policy Gate/authorization boundary。 */
  authorize: ControlPlaneAuthorizer;
};

/** 不携带 raw signature、private key 或 bundle 的 control-plane 审计。 */
export type ControlPlaneAuditRecord = {
  /** 审计租户。 */
  tenantId: string;
  /** 请求标识。 */
  requestId: string;
  /** 追踪标识。 */
  traceId: string;
  /** control-plane 操作。 */
  operation: ControlPlaneOperation;
  /** 操作涉及的插件。 */
  pluginId: string;
  /** 操作是否成功。 */
  result: 'accepted' | 'rejected';
  /** 操作版本。 */
  version?: string;
  /** 稳定拒绝码。 */
  reasonCode?: string;
  /** 审计创建时间。 */
  occurredAt: string;
};

/** tenant control plane 的公开异步 API。 */
export type TenantControlPlane = {
  request<T = unknown>(input: unknown): Promise<TenantControlPlaneResponse<T>>;
};
