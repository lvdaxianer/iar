/**
 * 提供带 tenant/actor 授权的 transport-neutral Service API。
 *
 * Service API 复用 Fastify v1 路由，避免 Service 与 Embedded 产生第二套运行时语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import { replayEvents } from '@iar/runtime';
import { createFastifyApp, type FastifyHostOptions } from '@iar/adapters-fastify';
import { FASTIFY_API_VERSION, FASTIFY_RESPONSE_VERSION, type FastifyApiError, type FastifyApiResponse } from '@iar/adapters-fastify';
import { isJsonValue, publicPlugin, recordBody, readString } from '@iar/adapters-fastify/http-boundary';
import type { TenantAuthorizer, TenantRequestContext } from './types.js';

/** Service 协议的稳定版本。 */
export const SERVICE_API_PROTOCOL_VERSION = 'iar.service-api/v1' as const;

/** Service API 支持的有限操作集合。 */
export type ServiceApiOperation = 'run.create' | 'run.input' | 'run.get' | 'run.confirm' | 'run.replay' | 'plugin.install' | 'plugin.enable' | 'plugin.disable' | 'plugin.inspect';

/** Service API 的协议请求。 */
export type ServiceApiRequest = {
  protocolVersion: typeof SERVICE_API_PROTOCOL_VERSION;
  requestId: string;
  traceId: string;
  context: TenantRequestContext;
  operation: ServiceApiOperation;
  payload: unknown;
};

/** Service API 在 Fastify v1 envelope 上附加 transport 元数据。 */
export type ServiceApiResponse<T = unknown> = FastifyApiResponse<T> & {
  protocolVersion: typeof SERVICE_API_PROTOCOL_VERSION;
  requestId: string;
  tenantId: string;
};

/** Service API 的注入依赖。 */
export type ServiceApiOptions = {
  /** 每个 tenant 创建一次 Workflow/PluginHost，后续请求复用同一状态。 */
  hostFactory: (tenantId: string) => FastifyHostOptions;
  /** 每个请求执行的 actor/tenant 授权器。 */
  authorize: TenantAuthorizer;
};

/** 可被 Sidecar、CLI 或其他 transport 复用的 Service API。 */
export type ServiceApi = {
  request<T = unknown>(request: ServiceApiRequest): Promise<ServiceApiResponse<T>>;
  close(): Promise<void>;
};

/** 只需要 request 能力的 transport client 依赖。 */
export type ServiceApiClient = { request(request: ServiceApiRequest): Promise<ServiceApiResponse> };

type TenantHost = { app: Awaited<ReturnType<typeof createFastifyApp>>; options: FastifyHostOptions };
type ServiceRuntime = { hosts: Map<string, Promise<TenantHost>>; owners: WeakMap<object, string>; options: ServiceApiOptions };
type ResponseContext = { requestId: string; traceId: string; tenantId: string; runId?: string };
type Route = { method: 'GET' | 'POST'; path: string; body?: unknown };

/**
 * 创建授权、租户缓存和 Fastify contract 转发组成的 Service API。
 *
 * @param options - host 工厂和请求授权器
 * @returns 可供 Service/Sidecar/CLI 复用的 API
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createServiceApi(options: ServiceApiOptions): ServiceApi {
  const runtime: ServiceRuntime = { hosts: new Map(), owners: new WeakMap(), options };
  return { request: <T>(request: ServiceApiRequest) => requestService<T>(runtime, request), close: () => closeHosts(runtime.hosts) };
}

/** @param runtime - Service 运行时 @param request - 外部请求 @returns 稳定 Service 响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
async function requestService<T>(runtime: ServiceRuntime, request: ServiceApiRequest): Promise<ServiceApiResponse<T>> {
  const normalized = normalizeRequest(request);
  // 协议边界失败时不读取租户或初始化 host。
  if (!normalized.ok) return serviceFailure<T>({ requestId: '', traceId: '', tenantId: '' }, normalized.code, normalized.message);
  const { context } = normalized.value;
  // 授权器失败或拒绝都必须在 runtime 访问前结束。
  if (!authorized(runtime.options.authorize, context)) return serviceFailure<T>(responseContext(normalized.value), 'service.authorization_failed', 'Service 请求未获得授权');
  const host = await getTenantHost(runtime, context.tenantId);
  // host 初始化失败不把内部异常传播给 transport。
  if (!host.ok) return serviceFailure<T>(responseContext(normalized.value), 'service.host_unavailable', 'Service runtime 不可用');
  // 业务操作异常统一转换为稳定错误 envelope。
  try { return await executeOperation<T>(host.value, normalized.value); } catch { return serviceFailure<T>(responseContext(normalized.value), 'service.operation_failed', 'Service 操作未完成'); }
}

/** @param hosts - 租户 host promise 集合 @returns 关闭所有 host @author lvdaxianer@yeah.net @date 2026-10-17 */
async function closeHosts(hosts: Map<string, Promise<TenantHost>>): Promise<void> {
  const entries = await Promise.all(hosts.values()); hosts.clear(); await Promise.all(entries.map(({ app }) => app.close()));
}

/** @param request - 已规范化请求 @param runId - 可选 run ID @returns 响应元数据 @author lvdaxianer@yeah.net @date 2026-10-17 */
function responseContext(request: ServiceApiRequest, runId?: string): ResponseContext {
  return { requestId: request.requestId, traceId: request.traceId, tenantId: request.context.tenantId, ...(runId === undefined ? {} : { runId }) };
}

/** @param request - 未知外部请求 @returns 规范化请求或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function normalizeRequest(request: ServiceApiRequest): { ok: true; value: ServiceApiRequest } | { ok: false; code: string; message: string } {
  try {
    // 非对象请求不能读取协议字段，直接返回统一 invalid_request。
    if (typeof request !== 'object' || request === null) return { ok: false, code: 'service.invalid_request', message: 'Service 请求无效' };
    // 所有协议元数据、上下文、操作和 payload 都必须同时通过边界校验。
    if (request.protocolVersion !== SERVICE_API_PROTOCOL_VERSION || !nonEmpty(request.requestId) || !nonEmpty(request.traceId) || !validContext(request.context) || !isOperation(request.operation) || !isJsonValue(request.payload)) {
      return { ok: false, code: 'service.invalid_request', message: 'Service 请求无效' };
    }
    return { ok: true, value: { ...request, context: Object.freeze({ ...request.context }) } };
  } catch {
    // getter 或 JSON 边界异常也统一视为 invalid_request。
    return { ok: false, code: 'service.invalid_request', message: 'Service 请求无效' };
  }
}

/**
 * 以严格字符串边界校验 requestId、traceId 和上下文标识。
 *
 * @param value - 未信任的外部字段
 * @returns 是否为非空、无控制字符的稳定字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * 检查请求上下文的 tenant/actor 标识，不允许 payload 覆盖租户。
 *
 * @param value - 未信任的上下文对象
 * @returns 是否满足 tenant/actor 边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validContext(value: unknown): value is TenantRequestContext {
  // null、数组和 primitive 不能作为授权上下文。
  if (typeof value !== 'object' || value === null) return false;
  const context = value as Partial<TenantRequestContext>;
  // tenant 与 actor 必须同时是有界字符串。
  return nonEmpty(context.tenantId) && nonEmpty(context.actorId);
}

/**
 * 确认操作来自有限白名单，防止 transport 动态扩展宿主能力。
 *
 * @param value - 外部 operation 字段
 * @returns 是否属于公开 Service operation 集合
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isOperation(value: unknown): value is ServiceApiOperation {
  return typeof value === 'string' && ['run.create', 'run.input', 'run.get', 'run.confirm', 'run.replay', 'plugin.install', 'plugin.enable', 'plugin.disable', 'plugin.inspect'].includes(value);
}

/**
 * 授权器异常按拒绝处理，Service API 保持 fail-closed。
 *
 * @param authorize - actor/tenant 授权器
 * @param context - 当前请求上下文
 * @returns 是否允许访问 tenant host
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function authorized(authorize: TenantAuthorizer, context: TenantRequestContext): boolean {
  try {
    // 授权器返回 false 时直接拒绝，不访问任何 host。
    return authorize(context);
  } catch {
    // 授权器异常按拒绝处理，保持 fail-closed。
    return false;
  }
}

/** @param runtime - host 缓存和工厂 @param tenantId - 已授权租户 @returns host 或稳定失败 @author lvdaxianer@yeah.net @date 2026-10-17 */
async function getTenantHost(runtime: ServiceRuntime, tenantId: string): Promise<{ ok: true; value: TenantHost } | { ok: false }> {
  const existing = runtime.hosts.get(tenantId);
  // 已初始化的同租户 host 直接等待原 promise。
  if (existing) return settleHost(runtime.hosts, tenantId, existing);
  // 首次访问创建 pending，避免并发请求重复初始化。
  const pending = createTenantHost(runtime, tenantId);
  runtime.hosts.set(tenantId, pending);
  // 初始化失败由 settleHost 清理缓存并稳定化。
  return settleHost(runtime.hosts, tenantId, pending);
}

/** @param hosts - host 缓存 @param tenantId - 租户键 @param pending - host promise @returns 已完成 host @author lvdaxianer@yeah.net @date 2026-10-17 */
async function settleHost(hosts: Map<string, Promise<TenantHost>>, tenantId: string, pending: Promise<TenantHost>): Promise<{ ok: true; value: TenantHost } | { ok: false }> {
  try { return { ok: true, value: await pending }; } catch { // 初始化异常必须清除失败缓存。
    hosts.delete(tenantId); return { ok: false };
  }
}

/** @param runtime - Service 运行时 @param tenantId - 租户键 @returns 待完成 host @author lvdaxianer@yeah.net @date 2026-10-17 */
function createTenantHost(runtime: ServiceRuntime, tenantId: string): Promise<TenantHost> {
  return Promise.resolve().then(async () => { const options = runtime.options.hostFactory(tenantId); claimHost(runtime.owners, options, tenantId); return { app: await createFastifyApp(options), options }; });
}

/** @param owners - 资源所有者映射 @param options - host 资源 @param tenantId - 租户键 @returns 无返回值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function claimHost(owners: WeakMap<object, string>, options: FastifyHostOptions, tenantId: string): void {
  for (const resource of [options.workflow, options.pluginHost]) {
    const owner = owners.get(resource);
    // 资源可以由同一租户复用，不能由其他租户复用。
    if (owner && owner !== tenantId) throw new Error('cross-tenant host reuse');
  }
  owners.set(options.workflow, tenantId);
  owners.set(options.pluginHost, tenantId);
}

/**
 * 将有限 Service operation 映射到既有 Fastify v1 路由或只读 replay。
 *
 * @param host - 当前 tenant 的 Fastify app 和核心服务
 * @param request - 已完成 Service 边界校验的请求
 * @returns 保留 Fastify data/error 语义的 Service response
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function executeOperation<T>(host: TenantHost, request: ServiceApiRequest): Promise<ServiceApiResponse<T>> {
  if (request.operation === 'plugin.inspect') return inspectPlugin<T>(host, request);
  if (request.operation === 'run.replay') return replayRun<T>(host, request);
  const route = routeFor(request.operation, request.payload);
  const payload = route.body === undefined ? undefined : route.body;
  const injectOptions = { method: route.method, url: route.path, headers: { 'x-trace-id': request.traceId }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) };
  const response = await (host.app as { inject(options: unknown): Promise<{ statusCode: number; json(): unknown }> }).inject(injectOptions);
  return fromFastifyResponse<T>(response.statusCode, response.json() as FastifyApiResponse<T>, request);
}

/**
 * 生成固定路由，路径参数只来自已验证的非空字符串。
 *
 * @param operation - 已在白名单中的 Service operation
 * @param payload - operation 的 JSON payload
 * @returns Fastify method/path/body 三元组
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
const routeBuilders: Record<Exclude<ServiceApiOperation, 'plugin.inspect' | 'run.replay'>, (payload: unknown) => Route> = {
  'run.create': (payload) => ({ method: 'POST', path: '/v1/runs', body: payload }),
  'run.input': (payload) => runRoute('input', payload, true), 'run.get': (payload) => runRoute('', payload, false),
  'run.confirm': (payload) => runRoute('confirm', payload, true), 'plugin.install': (payload) => ({ method: 'POST', path: '/v1/plugins/install', body: { manifest: readField(recordBody(payload), 'manifest') } }),
  'plugin.enable': (payload) => pluginRoute('enable', payload), 'plugin.disable': (payload) => pluginRoute('disable', payload)
};

/** @param operation - operation 键 @param payload - JSON payload @returns 固定路由 @author lvdaxianer@yeah.net @date 2026-10-17 */
function routeFor(operation: Exclude<ServiceApiOperation, 'plugin.inspect' | 'run.replay'>, payload: unknown): Route { return routeBuilders[operation](payload); }

/** @param action - run 路径后缀 @param payload - JSON payload @param body - 是否发送 body @returns run 路由 @author lvdaxianer@yeah.net @date 2026-10-17 */
function runRoute(action: string, payload: unknown, body: boolean): Route {
  const runId = encodeURIComponent(readString(recordBody(payload), 'runId') ?? '');
  return { method: body ? 'POST' : 'GET', path: `/v1/runs/${runId}${action ? `/${action}` : ''}`, ...(body ? { body: payload } : {}) };
}

/** @param action - plugin 操作 @param payload - JSON payload @returns plugin 路由 @author lvdaxianer@yeah.net @date 2026-10-17 */
function pluginRoute(action: 'enable' | 'disable', payload: unknown): Route { return { method: 'POST', path: `/v1/plugins/${encodeURIComponent(readString(recordBody(payload), 'pluginId') ?? '')}/${action}` }; }

/**
 * 读取 payload 字段而不把 getter 异常传播到 Service 边界。
 *
 * @param record - 已收窄的 payload object
 * @param key - 待读取字段名
 * @returns 字段值或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function readField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

/**
 * 返回插件的有限摘要，不暴露完整 Manifest 或 Handler。
 *
 * @param host - 当前 tenant host
 * @param request - plugin.inspect 请求
 * @returns 插件摘要或稳定 unavailable 错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function inspectPlugin<T>(host: TenantHost, request: ServiceApiRequest): ServiceApiResponse<T> {
  const pluginId = readString(recordBody(request.payload), 'pluginId');
  const record = pluginId ? host.options.pluginHost.get(pluginId) : undefined;
  if (!record) return serviceFailure<T>(responseContext(request), 'plugin.unavailable', 'Plugin 当前不可用');
  return serviceSuccess(request, { plugin: publicPlugin(record) } as T, '');
}

/**
 * 只读当前 tenant 的 Workflow 事件并重放，不执行副作用。
 *
 * @param host - 当前 tenant host
 * @param request - run.replay 请求
 * @returns 重放后的 BehaviorContext 或稳定错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function replayRun<T>(host: TenantHost, request: ServiceApiRequest): ServiceApiResponse<T> {
  const runId = readString(recordBody(request.payload), 'runId');
  const events = host.options.workflow.events.filter((event) => !runId || event.runId === runId);
  if (events.length === 0) return serviceFailure<T>(responseContext(request), 'workflow_not_found', 'Workflow 不存在');
  try {
    const context = replayEvents(events);
    return serviceSuccess(request, context as T, runId ?? context.integrity.lastEventId);
  } catch {
    return serviceFailure<T>(responseContext(request, runId ?? ''), 'service.replay_failed', 'Workflow replay 未完成');
  }
}

/**
 * 将 Fastify response 转换为 Service response，同时保留原有 error/data 语义。
 *
 * @param statusCode - Fastify HTTP status
 * @param body - Fastify v1 response body
 * @param request - 原始 Service request
 * @returns 附加 service metadata 的 response
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function fromFastifyResponse<T>(statusCode: number, body: FastifyApiResponse<T>, request: ServiceApiRequest): ServiceApiResponse<T> {
  if (!body || body.schemaVersion !== FASTIFY_RESPONSE_VERSION || body.version !== FASTIFY_API_VERSION || typeof body.error === 'undefined') {
    return serviceFailure<T>(responseContext(request), 'service.invalid_response', 'Service runtime 响应无效');
  }
  return { protocolVersion: SERVICE_API_PROTOCOL_VERSION, requestId: request.requestId, tenantId: request.context.tenantId, schemaVersion: body.schemaVersion, traceId: body.traceId, runId: body.runId, version: body.version, data: statusCode >= 400 ? null : body.data, error: statusCode >= 400 ? body.error ?? { code: 'service.operation_failed', message: 'Service 操作未完成', retryable: true } : body.error };
}

/**
 * 构造成功响应并保持 Fastify v1 字段兼容。
 *
 * @param request - 原始 Service request
 * @param data - 脱敏后的公开数据
 * @param runId - 关联的 Workflow 标识
 * @returns 版本化成功响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function serviceSuccess<T>(request: ServiceApiRequest, data: T, runId: string): ServiceApiResponse<T> {
  return { protocolVersion: SERVICE_API_PROTOCOL_VERSION, requestId: request.requestId, tenantId: request.context.tenantId, schemaVersion: FASTIFY_RESPONSE_VERSION, traceId: request.traceId, runId, version: FASTIFY_API_VERSION, data, error: null };
}

/** @param context - 响应元数据 @param code - 稳定错误码 @param message - 安全错误消息 @returns 版本化失败响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
function serviceFailure<T>(context: ResponseContext, code: string, message: string): ServiceApiResponse<T> {
  const error: FastifyApiError = { code, message, retryable: code === 'service.host_unavailable' || code === 'service.operation_failed' };
  return { protocolVersion: SERVICE_API_PROTOCOL_VERSION, requestId: context.requestId, tenantId: context.tenantId, schemaVersion: FASTIFY_RESPONSE_VERSION, traceId: context.traceId, runId: context.runId ?? '', version: FASTIFY_API_VERSION, data: null, error };
}

export type { JsonValue };
