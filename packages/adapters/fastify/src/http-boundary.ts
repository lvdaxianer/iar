/**
 * 提供 Fastify 请求审计、异常边界、输入读取、公开投影和统一响应。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JsonValue } from '@iar/contracts';
import type { PluginRecord } from '@iar/plugins';
import type { WorkflowRun } from '@iar/workflow';
import { FASTIFY_API_VERSION, FASTIFY_RESPONSE_VERSION, type FastifyApiError, type FastifyApiResponse, type FastifyHostApp, type FastifyHostOptions, type PublicPlugin, type PublicWorkflowRun } from './types.js';

/** 未知 HTTP body 的安全字段读取视图。 */
export type UnknownRecord = Record<string, unknown>;

/** 带有 runId/pluginId 参数的 Fastify 请求。 */
export type RequestWithParams = FastifyRequest<{ Params: UnknownRecord }>;

/** Fastify adapter 共享的核心依赖和请求审计状态。 */
export type AdapterContext = { options: FastifyHostOptions; nextTraceId: () => string; traceIds: WeakMap<object, string>; requestStartedAt: WeakMap<object, number> };
type TraceIdOptions = { request: FastifyRequest; body: UnknownRecord; nextTraceId: () => string; traceIds?: WeakMap<object, string> };
type ErrorHandlerOptions = { error: unknown; request: FastifyRequest; reply: FastifyReply; context: AdapterContext };

/**
 * 注册请求审计和稳定 HTTP 错误边界。
 * @param app - Fastify 实例
 * @param context - adapter 上下文
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function registerHttpBoundaries(app: FastifyHostApp, context: AdapterContext): void {
  registerRequestLogging(app, context);
  registerErrorBoundary(app, context);
}

/**
 * 记录安全的请求开始、结束和耗时摘要。
 * @param app - Fastify 实例
 * @param context - 请求 trace 和开始时间存储
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registerRequestLogging(app: FastifyHostApp, context: AdapterContext): void {
  app.addHook('onRequest', async (request) => {
    const traceId = readString(request.headers as UnknownRecord, 'x-trace-id') ?? context.nextTraceId();
    const startTime = Date.now();
    context.traceIds.set(request, traceId);
    context.requestStartedAt.set(request, startTime);
    request.log.info({ requestId: request.id, traceId, method: request.method, path: request.url.split('?')[0], startTime }, 'fastify request started');
  });
  app.addHook('onResponse', async (request, reply) => {
    const endTime = Date.now();
    const startTime = context.requestStartedAt.get(request) ?? endTime;
    request.log.info({ requestId: request.id, traceId: context.traceIds.get(request) ?? 'trace-unknown', method: request.method, path: request.url.split('?')[0], startTime, endTime, durationMs: endTime - startTime, status: reply.statusCode }, 'fastify request completed');
  });
}

/**
 * 将 Fastify 解析错误、未知路由和未预期异常收敛为统一 envelope。
 * @param app - Fastify 实例
 * @param context - 请求 trace 和读取依赖
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registerErrorBoundary(app: FastifyHostApp, context: AdapterContext): void {
  app.setErrorHandler((error, request, reply) => handleError({ error, request, reply, context }));
  app.setNotFoundHandler((request, reply) => handleNotFound(request, reply, context));
}

/**
 * 处理 Fastify 客户端解析错误和内部异常。
 * @param error - 未知 Fastify 或内部异常
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @param context - adapter 上下文
 * @returns 统一错误响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function handleError(options: ErrorHandlerOptions): unknown {
  const body = recordBody(options.request.body);
  const traceId = requestTraceId({ request: options.request, body, nextTraceId: options.context.nextTraceId, traceIds: options.context.traceIds });
  const runId = readString(recordBody(options.request.params), 'runId') ?? readString(body, 'runId') ?? '';
  const errorCode = errorCodeOf(options.error);
  const clientError = errorCode?.startsWith('FST_ERR_CTP_') === true;
  // 客户端解析错误只记录稳定 code，避免原始 body 进入日志。
  if (clientError) options.request.log.warn({ requestId: options.request.id, traceId, errorCode }, 'fastify client request rejected');
  else /* 未预期异常保留安全诊断栈，响应只返回稳定 code。 */ options.request.log.error({ requestId: options.request.id, traceId, errorName: options.error instanceof Error ? options.error.name : 'UnknownError', stack: options.error instanceof Error ? options.error.stack : undefined }, 'fastify request failed');
  return send(options.reply, clientError ? 400 : 500, failure(traceId, runId, clientError ? invalidRequest('请求体无效') : internalError()));
}

/**
 * 处理未匹配路由并保持公开错误格式稳定。
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @param context - adapter 上下文
 * @returns 统一错误响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function handleNotFound(request: FastifyRequest, reply: FastifyReply, context: AdapterContext): unknown {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const runId = readString(recordBody(request.params), 'runId') ?? readString(body, 'runId') ?? '';
  request.log.warn({ requestId: request.id, traceId, path: request.url.split('?')[0] }, 'fastify route not found');
  return send(reply, 404, failure(traceId, runId, { code: 'api.route_not_found', message: 'API 路由不存在', retryable: false }));
}

/**
 * 将未知 body 转为可安全读取的对象。
 * @param value - 未知请求 body
 * @returns 普通对象或空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function recordBody(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

/**
 * 从请求 trace、header 或 body 兜底选择 traceId。
 * @param options - 当前请求、body 和 trace 工厂
 * @returns 稳定 traceId
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function requestTraceId(options: TraceIdOptions): string {
  const header = options.request.headers['x-trace-id'];
  const traceId = options.traceIds?.get(options.request) ?? (typeof header === 'string' && header.trim() ? header : readString(options.body, 'traceId') ?? options.nextTraceId());
  options.traceIds?.set(options.request, traceId);
  return traceId;
}

/**
 * 安全读取非空字符串字段。
 * @param record - 未知字段对象
 * @param key - 字段名
 * @returns 非空字符串或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function readString(record: UnknownRecord, key: string): string | undefined {
  try {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安全读取未知字段，getter 异常按字段缺失处理。
 * @param record - 未知字段对象
 * @param key - 字段名
 * @returns 字段值或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function readField(record: UnknownRecord, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

/**
 * 验证值是无循环、无特殊对象的 JSON 值。
 * @param value - 未知输入值
 * @param seen - 当前递归路径上的对象集合
 * @returns 是否为合法 JsonValue
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true; // JSON 原始标量无需递归读取。
  if (typeof value === 'number') return Number.isFinite(value); // 非有限数字不是 JSON 值。
  if (typeof value !== 'object') return false; // 函数、symbol 和 bigint 直接拒绝。
  // 当前路径再次遇到同一对象时拒绝循环或共享引用逃逸。
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.keys(value).length === value.length && value.every((item) => isJsonValue(item, seen)); // 稀疏数组或子项异常均 fail-closed。
    return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen)); // 只接受普通对象及其合法子项。
  } catch {
    return false; // getter/prototype 异常不能穿透请求边界。
  }
}

/**
 * 判断值是否为带字段的普通对象。
 * @param value - 未知值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 投影公开 Workflow 摘要并隔离嵌套确认状态。
 * @param run - 内部 Workflow 快照
 * @returns 不含 definition 和 Action input 的公开摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function publicRun(run: WorkflowRun): PublicWorkflowRun {
  return { runId: run.runId, workflowId: run.workflowId, currentStep: run.currentStep, status: run.status, attempts: run.attempts, ...(run.actionStatus ? { actionStatus: run.actionStatus } : {}), ...(run.lastError ? { lastError: { ...run.lastError } } : {}), confirmation: structuredClone(run.confirmation) };
}

/**
 * 投影公开 Plugin 摘要并隐藏完整 Manifest。
 * @param record - PluginHost 生命周期记录
 * @returns 有限 plugin 摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function publicPlugin(record: PluginRecord): PublicPlugin {
  const base = { pluginId: record.manifest.pluginId, version: record.manifest.version, state: record.state };
  return record.manifest.pluginKind === 'business' ? { ...base, functionIds: [...record.functions.keys()] } : base;
}

/**
 * 创建成功响应 envelope。
 * @param traceId - 链路标识
 * @param runId - Workflow 标识
 * @param data - 公开成功数据
 * @returns 版本化成功响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function success<T>(traceId: string, runId: string, data: T): FastifyApiResponse<T> {
  return { schemaVersion: FASTIFY_RESPONSE_VERSION, traceId, runId, version: FASTIFY_API_VERSION, data, error: null };
}

/**
 * 创建失败响应 envelope。
 * @param traceId - 链路标识
 * @param runId - Workflow 标识
 * @param error - 稳定公开错误
 * @returns 版本化失败响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function failure<T>(traceId: string, runId: string, error: FastifyApiError): FastifyApiResponse<T> {
  return { schemaVersion: FASTIFY_RESPONSE_VERSION, traceId, runId, version: FASTIFY_API_VERSION, data: null, error };
}

/**
 * 创建稳定参数错误。
 * @param message - 不含原始请求内容的安全说明
 * @returns 参数错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function invalidRequest(message: string): FastifyApiError {
  return { code: 'api.invalid_request', message, retryable: false };
}

/**
 * 将 Workflow reasonCode 转为公开错误。
 * @param code - Workflow 稳定 reasonCode
 * @returns 不含内部详情的公开错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function workflowError(code: string): FastifyApiError {
  return { code, message: 'Workflow 请求未被接受', retryable: code === 'workflow_waiting' || code === 'workflow_not_retryable' };
}

/**
 * 将 PluginHost 错误转为公开错误。
 * @param code - PluginHost 稳定错误码
 * @returns 不含内部详情的公开错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function hostError(code: string): FastifyApiError {
  return { code, message: 'Plugin 请求未被接受', retryable: false };
}

/**
 * 创建不泄露异常正文的内部错误。
 * @returns 稳定内部错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function internalError(): FastifyApiError {
  return { code: 'api.internal_error', message: 'API 内部错误', retryable: true };
}

/**
 * 安全读取 Fastify 异常代码。
 * @param error - Fastify 或内部异常
 * @returns 稳定异常代码或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function errorCodeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/**
 * 映射 Workflow 错误的 HTTP 状态。
 * @param code - Workflow 错误码
 * @returns HTTP 状态码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function workflowStatus(code: string): number {
  // 未知 run 是资源不存在，scope mismatch 是状态冲突，其余按参数错误处理。
  if (code === 'workflow_not_found') return 404;
  if (code === 'confirmation_scope_mismatch') return 409;
  return 400;
}

/**
 * 映射 PluginHost 错误的 HTTP 状态。
 * @param code - PluginHost 错误码
 * @returns HTTP 状态码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function pluginStatus(code: string): number {
  // 不可用/不存在是资源错误，生命周期/依赖冲突是状态冲突，其余按请求错误处理。
  const normalized = code.toLowerCase();
  return normalized.endsWith('.unavailable') || normalized.endsWith('.function_not_found') ? 404 : normalized.includes('.lifecycle') || normalized.includes('.dependency') || normalized.endsWith('.duplicate_id') ? 409 : 400;
}

/**
 * 统一发送 Fastify response envelope。
 * @param reply - Fastify 回复对象
 * @param status - HTTP 状态码
 * @param body - 已构造的响应 envelope
 * @returns Fastify send 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function send<T>(reply: { code: (status: number) => { send: (body: T) => unknown } }, status: number, body: T): unknown {
  return reply.code(status).send(body);
}
