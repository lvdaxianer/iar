/**
 * 在沙箱 HTTP 入口输出有界的请求审计信息。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runWithLogContext, writeSafeLog } from './safe-log.js';

/** 请求生命周期内使用的审计元数据。 */
type AuditContext = { requestId: string; traceId: string; startTime: number; isEnded: boolean };
/** 固定路由集合避免未知路径携带自由文本进入日志。 */
const SAFE_PATHS = new Set(['/', '/api/chat', '/api/confirm', '/api/compact', '/api/state', '/api/reset',
  '/api/sessions', '/api/sessions/:sessionId', '/api/sessions/:sessionId/chat', '/api/sessions/:sessionId/confirm',
  '/api/sessions/:sessionId/compact', '/api/sessions/:sessionId/state', '/api/sessions/:sessionId/reset']);
/** 仅允许输出标准方法名称。 */
const SAFE_METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
/** 客户端断开时的审计状态，表示未完成的响应。 */
const CLIENT_CLOSED_STATUS = 499;
/** 写入失败发生在响应头之后时使用的审计状态，非实际响应码。 */
const STREAM_WRITE_FAILURE_STATUS = 500;
/** 仅弱引用关联响应与入口上下文，不延长响应生命周期。 */
const responseContexts = new WeakMap<ServerResponse, AuditContext>();

/**
 * 仅记录一次请求结束状态。
 *
 * @param context - 请求审计上下文
 * @param status - 最终状态码
 * @param outcome - 可选的固定失败或断开分类
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function finishAudit(context: AuditContext, status: number, outcome?: 'aborted' | 'stream_write_failed'): void {
  // 多个结束事件可能同时发生，只保留第一条审计。
  if (context.isEnded) return;
  context.isEnded = true;
  const endTime = Date.now();
  writeSafeLog({ level: 'info', event: 'http.request.end', ...context,
    endTime, durationMs: endTime - context.startTime, status, ...(outcome ? { outcome } : {}) });
}

/**
 * 响应写入故障立即终结入口审计，避免后续 onResponse 误报成功。
 * @param raw - 已建立入口上下文的响应
 * @returns 入口尚未结束或响应不属于 HTTP 入口时返回真
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function auditStreamWriteFailure(raw: ServerResponse): boolean {
  const context = responseContexts.get(raw);
  if (context?.isEnded) return false;
  if (context) finishAudit(context, STREAM_WRITE_FAILURE_STATUS, 'stream_write_failed');
  return true;
}

/**
 * 注册统一请求入口与出口审计钩子。
 *
 * @param app - 沙箱 HTTP 服务
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function registerRequestAudit(app: FastifyInstance): void {
  const contexts = new WeakMap<FastifyRequest, AuditContext>();
  app.addHook('onRequest', (request, reply, done) => startAudit(contexts, { request, reply, done }));
  app.addHook('onResponse', (request, reply, done) => {
    const context = contexts.get(request);
    // 只有入口已建立上下文时才输出对应结束记录。
    if (context !== undefined) {
      finishAudit(context, reply.statusCode);
    }
    done();
  });
}

/**
 * 建立请求审计并在异步上下文中执行入口。
 *
 * @param contexts - 请求与审计上下文的关联
 * @param options - HTTP 请求、响应及后续处理
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function startAudit(contexts: WeakMap<FastifyRequest, AuditContext>, options: { request: FastifyRequest; reply: FastifyReply; done: () => void }): void {
  const { request, reply, done } = options;
  const context = { requestId: randomUUID(), traceId: randomUUID(), startTime: Date.now(), isEnded: false };
  contexts.set(request, context);
  responseContexts.set(reply.raw, context);
  const path = request.routeOptions.url ?? '';
  const method = request.method;
  writeSafeLog({ level: 'info', event: 'http.request.start', ...context,
    method: SAFE_METHODS.has(method) ? method : 'OTHER', path: SAFE_PATHS.has(path) ? path : 'unknown' });
  reply.raw.once('close', () => {
    // 响应尚未完成就关闭时，Fastify 可能不会触发正常结束钩子。
    if (!reply.raw.writableFinished) finishAudit(context, CLIENT_CLOSED_STATUS, 'aborted');
  });
  runWithLogContext(context, done);
}
