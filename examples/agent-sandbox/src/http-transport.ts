/**
 * 注册沙箱已有 HTTP 交互入口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IarSandboxSession } from './session.js';
import { streamTurn } from './http-stream-transport.js';

/**
 * 为已有会话注册 HTTP 路由。
 *
 * @param app - 沙箱 HTTP 服务
 * @param session - 沙箱会话
 * @param indexHtml - 静态页面内容
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function registerSandboxRoutes(app: FastifyInstance, session: IarSandboxSession, indexHtml: string): void {
  app.get('/', async (_request, reply) => {
    void reply.type('text/html; charset=utf-8');
    return indexHtml;
  });
  app.post('/api/chat', async (request, reply) => {
    const body = asRecord(request.body);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    // 空消息沿用既有响应契约。
    if (message.length === 0) return { status: 'failed', reply: '消息不能为空。', reasonCode: 'empty_message' };
    return wantsStream(request, body) ? streamTurn(session, message, reply) : session.turn(message);
  });
  app.post('/api/confirm', async (request) => session.confirm(asRecord(request.body).accepted === true));
  app.post('/api/compact', async () => session.compact());
  app.get('/api/state', async () => session.state());
  app.post('/api/reset', async () => { await session.reset(); return { ok: true }; });
}

/**
 * 把未知请求体收窄为普通对象。
 *
 * @param value - 未知请求体
 * @returns 普通对象或空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 判断本次聊天请求是否要求流式响应。
 *
 * @param request - Fastify 请求
 * @param body - 请求体
 * @returns 是否走 SSE 流式
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function wantsStream(request: FastifyRequest, body: Record<string, unknown>): boolean {
  // 请求体指定流式时无需检查查询参数。
  if (body.stream === true) return true;
  const query = asRecord(request.query);
  return query.stream === '1' || query.stream === 'true';
}
