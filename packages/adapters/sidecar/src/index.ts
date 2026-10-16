/**
 * 提供 JSON/HTTP Sidecar transport，不复制 IAR 的 Workflow 或 PluginHost 语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServiceApi, ServiceApiRequest, ServiceApiResponse } from './service-placeholder.js';

/** Sidecar response 使用独立 transport 版本，data/error 仍与 Service API 相同。 */
export const SIDECAR_PROTOCOL_VERSION = 'iar.sidecar/v1' as const;

/** JSON/HTTP sidecar 的最大请求体配置。 */
export type SidecarServerOptions = { bodyLimit?: number };

/** ServiceApi 最小 client，便于 Unix socket、HTTP 和测试替身复用。 */
export type SidecarApiClient = Pick<ServiceApi, 'request'>;

/** Sidecar transport 返回的响应形状。 */
export type SidecarResponse<T = unknown> = Omit<ServiceApiResponse<T>, 'protocolVersion'> & { protocolVersion: typeof SIDECAR_PROTOCOL_VERSION };

/** JSON transport 的最小操作接口。 */
export type SidecarTransport = { handle(request: unknown): Promise<SidecarResponse>; handleJson(payload: string): Promise<string> };
type FailureContext = { requestId: string; traceId: string; tenantId: string };
const EMPTY_CONTEXT: FailureContext = { requestId: '', traceId: '', tenantId: '' };

/**
 * 创建把 JSON 请求转发到 ServiceApi 的 Sidecar transport。
 *
 * @param api - 与 transport 无关的 ServiceApi client
 * @returns JSON 请求/响应处理器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createSidecarTransport(api: SidecarApiClient): SidecarTransport {
  return { handle: (request) => handleRequest(api, request), handleJson: (payload) => handleJson(api, payload) };
}

/** @param api - ServiceApi 客户端 @param request - 未知请求 @returns sidecar 响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
async function handleRequest(api: SidecarApiClient, request: unknown): Promise<SidecarResponse> {
  // 非 object 请求不能进入 Service API。
  if (!isRecord(request)) return sidecarFailure(EMPTY_CONTEXT, 'sidecar.invalid_request', 'Sidecar 请求无效');
  try {
    const response = await api.request(request as ServiceApiRequest);
    return { ...response, protocolVersion: SIDECAR_PROTOCOL_VERSION };
  } catch {
    // Service 异常转换为稳定 transport 错误。
    return sidecarFailure(EMPTY_CONTEXT, 'sidecar.transport_failed', 'Sidecar transport 未完成');
  }
}

/** @param api - ServiceApi 客户端 @param payload - JSON 文本 @returns 序列化 sidecar 响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
async function handleJson(api: SidecarApiClient, payload: string): Promise<string> {
  try {
    return JSON.stringify(await handleRequest(api, JSON.parse(payload) as unknown));
  } catch {
    // JSON parse 失败不回显原文。
    return JSON.stringify(sidecarFailure(EMPTY_CONTEXT, 'sidecar.invalid_json', 'Sidecar JSON 无效'));
  }
}

/**
 * 创建标准 Node HTTP server，POST /v1/sidecar 是唯一 sidecar 路由。
 *
 * @param transport - JSON request/response transport
 * @param options - body limit 等 HTTP 配置
 * @returns 尚未 listen 的 Node HTTP server
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createSidecarServer(transport: SidecarTransport, options: SidecarServerOptions = {}): Server {
  const bodyLimit = normalizeBodyLimit(options.bodyLimit);
  return createServer(async (request, response) => {
    // 非 POST 或未知路径不能进入 transport。
    if (request.method !== 'POST' || request.url?.split('?')[0] !== '/v1/sidecar') {
      writeJson(response, request.method === 'POST' ? 404 : 405, sidecarFailure(EMPTY_CONTEXT, 'sidecar.route_not_found', 'Sidecar 路由不存在'));
      return;
    }
    const body = await readBody(request, bodyLimit);
    // body 读取失败或超限统一返回 413。
    if (!body.ok) {
      writeJson(response, 413, sidecarFailure(EMPTY_CONTEXT, body.code, body.message));
      return;
    }
    const payload = await transport.handleJson(body.value);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(payload);
  });
}

/**
 * 读取有限 body，超限时停止收集并返回稳定错误。
 *
 * @param request - Node HTTP 请求流
 * @param limit - 最大 UTF-8 字节数
 * @returns body 文本或稳定错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function readBody(request: IncomingMessage, limit: number): Promise<{ ok: true; value: string } | { ok: false; code: string; message: string }> {
  const length = Number(request.headers['content-length'] ?? 0);
  // 已知 content-length 超限时无需收集 body。
  if (Number.isFinite(length) && length > limit) return rejectBody(request);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      // 数据块读取后的累计字节数仍必须受上限约束。
      if (total > limit) return rejectBody(request);
      chunks.push(buffer);
    }
  } catch {
    // 请求流错误转换为稳定 body_read_failed。
    return { ok: false, code: 'sidecar.body_read_failed', message: 'Sidecar 请求读取失败' };
  }
  return { ok: true, value: Buffer.concat(chunks).toString('utf8') };
}

/** @param value - 配置的 body limit @returns 已验证字节上限 @author lvdaxianer@yeah.net @date 2026-10-17 */
function normalizeBodyLimit(value: number | undefined): number {
  if (value === undefined) return 1024 * 1024; // 默认上限保持有限。
  // 非有限或非正整数配置必须在创建 server 时拒绝。
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Sidecar bodyLimit 必须是正整数');
  return value;
}

/** @param request - HTTP 请求流 @returns 稳定超限错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function rejectBody(request: IncomingMessage): { ok: false; code: string; message: string } {
  request.resume(); // 返回 413 前继续消费请求流。
  return { ok: false, code: 'sidecar.body_too_large', message: 'Sidecar 请求过大' };
}

/**
 * 写入 JSON response，不把原始错误交给 HTTP client。
 *
 * @param response - Node HTTP response
 * @param statusCode - HTTP status
 * @param body - 已稳定化的 sidecar response
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function writeJson(response: ServerResponse, statusCode: number, body: SidecarResponse): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

/**
 * 构造 JSON object 形状判断，拒绝数组和 null。
 *
 * @param value - 未知 transport 输入
 * @returns 是否为普通 object
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 构造 sidecar transport 级稳定错误。
 *
 * @param context - 响应元数据
 * @param code - 稳定 transport 错误码
 * @param message - 不泄露内部细节的消息
 * @returns Sidecar 错误响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sidecarFailure<T>(context: FailureContext, code: string, message: string): SidecarResponse<T> {
  return { protocolVersion: SIDECAR_PROTOCOL_VERSION, requestId: context.requestId, traceId: context.traceId, tenantId: context.tenantId, schemaVersion: 'iar.fastify-response/v1', runId: '', version: 'fastify.v1', data: null, error: { code, message, retryable: false } };
}
