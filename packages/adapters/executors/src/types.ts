/**
 * 定义 Worker、Sidecar、container 共用的隔离执行器边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { PluginHandlerContext, PluginHandlerResult } from '@iar/plugins';
import type { HookSubscription, SubscriptionRegistry } from '@iar/subscriptions';

/*
 * protocolVersion 是跨进程协商的唯一版本入口。
 * requestId 用于幂等和活动请求清理。
 * traceId 只用于关联，不承载用户输入或凭据。
 * tenantId 绑定所有 plugin、version 和 credential scope。
 * pluginVersion 必须与 executor 固定版本精确匹配。
 * capabilities 是有限 allow-list，不允许通配能力。
 * credentialRefs 只引用 secret 名称，不携带 secret 内容。
 * input 必须是 JSON-safe 值，避免函数或原型污染进入边界。
 * timeoutMs 是单次执行预算，不能成为无限等待。
 * data/error 互斥但始终存在，便于 transport 稳定解析。
 * mode 只描述 adapter 类型，不改变执行结果语义。
 * CredentialScope 不包含 secret，只提供授权所需三元组。
 * ExecutorHandler 通过 AbortSignal 接收取消通知。
 * CleanupReport 返回排序后的 ID，避免测试和审计不确定。
 * subscriptionRegistry 是可选清理目标，不改变默认执行路径。
 * subscriptionOwner 由宿主提供，避免 executor 猜测订阅归属。
 * subscriptionIds 由宿主提供，避免 Registry 暴露内部 Map。
 * 所有公开类型只表达边界，不暴露内部 active map。
 * ExecutorMode 是可审计的有限联合类型。
 * ExecutorError 的 code 是客户端状态机唯一依据。
 * retryable 只由核心根据错误类别设置。
 * ExecutorRequest 的字段顺序不影响 JSON 语义。
 * PluginHandlerContext 由核心重新构造，拒绝调用方注入 registry。
 * Handler 只接收输入、只读上下文和 signal。
 * CleanupReport 不返回凭据、输入或异常正文。
 * Options callback 由宿主控制，executor 不猜测外部资源。
 * SubscriptionRegistry 只在显式配置时参与 cleanup。
 * 版本固定发生在每次 execute，而不是只发生在构造时。
 * 这些类型可以被 JSON/HTTP transport 直接复用。
 */

/** executor transport 的稳定版本。 */
export const EXECUTOR_PROTOCOL_VERSION = 'iar.executor/v1' as const;

/** 三种隔离执行模式；消息和结果语义必须保持一致。 */
export type ExecutorMode = 'worker' | 'sidecar' | 'container';

/** executor 对外返回的稳定错误。 */
export type ExecutorError = { code: string; message: string; retryable: boolean };

/** executor 接收的 JSON-safe、版本固定请求。 */
export type ExecutorRequest = {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  requestId: string;
  traceId: string;
  tenantId: string;
  pluginId: string;
  pluginVersion: string;
  capabilities: readonly string[];
  credentialRefs: readonly string[];
  input: JsonValue;
  timeoutMs: number;
};

/** executor 返回的统一结果 envelope。 */
export type ExecutorResponse = {
  protocolVersion: typeof EXECUTOR_PROTOCOL_VERSION;
  requestId: string;
  traceId: string;
  pluginId: string;
  pluginVersion: string;
  mode: ExecutorMode;
  data: PluginHandlerResult | null;
  error: ExecutorError | null;
};

/** 只向凭据 resolver 暴露非 secret 的绑定范围。 */
export type CredentialScope = { tenantId: string; pluginId: string; pluginVersion: string };

/** 插件 handler 能看到的最小输入、只读上下文和取消信号。 */
export type ExecutorHandler = (input: JsonValue, context: PluginHandlerContext, signal: AbortSignal) => Promise<PluginHandlerResult>;

/** 卸载清理报告，字段按稳定 ID 排序。 */
export type CleanupReport = { cancelledRequestIds: string[]; removedSubscriptionIds: string[] };

/** executor 的资源、能力、凭据和订阅清理依赖。 */
export type ExecutorOptions = {
  version: string;
  maxTimeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  allowedCapabilities?: readonly string[];
  resolveCredential?: (scope: CredentialScope, ref: string) => string | undefined;
  subscriptionRegistry?: SubscriptionRegistry;
  subscriptionIds?: (tenantId: string, pluginId: string) => readonly string[];
  subscriptionOwner?: (subscription: HookSubscription, tenantId: string, pluginId: string) => boolean;
};

/** 所有隔离模式都必须实现的执行器能力。 */
export type PluginExecutor = {
  readonly mode: ExecutorMode;
  execute(request: ExecutorRequest, handler: ExecutorHandler): Promise<ExecutorResponse>;
  cancel(requestId: string): boolean;
  cleanupPlugin(tenantId: string, pluginId: string): Promise<CleanupReport>;
  activeRequestCount(): number;
  close(): Promise<void>;
};
