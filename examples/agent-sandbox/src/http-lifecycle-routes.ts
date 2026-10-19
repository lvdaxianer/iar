/** 注册页面及独立会话的创建、删除生命周期入口。 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { SandboxSessionManager, SessionError } from './session-manager.js';
import type { RunOperation } from './http-reservation.js';
import { readSessionId } from './http-reservation.js';

// 创建会话返回随机标识；服务端不把业务上下文放入浏览器可见响应之外。
// 删除只接受 path 参数，避免从请求体读取可能与路由目标冲突的标识。
/** 生命周期路由只负责资源建立和释放，不参与聊天状态编排。 */
/** 创建入口不携带业务正文，删除入口则绑定 path 中的资源标识。 */
/** 删除等待会话队列完成后才返回，避免释放仍在使用的资源。 */
/**
 * 注册页面和会话生命周期路由。
 * 创建会话不进入旧兼容会话队列，删除则沿用目标会话的顺序预约。
 * @param app - Fastify 服务
 * @param options - 会话管理器、执行器和页面内容
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function registerSessionLifecycleRoutes(app: FastifyInstance, options: { manager: SandboxSessionManager; run: RunOperation; indexHtml: string }): void {
  const { manager, run, indexHtml } = options;
  app.get('/', async (_request, reply) => { void reply.type('text/html; charset=utf-8'); return indexHtml; });
  app.post('/api/sessions', async (_request, reply) => handleError(reply, async () => reply.code(201).send({ sessionId: manager.create() })));
  app.post('/api/sessions/:sessionId/resume', async (request, reply) => handleError(reply, async () => {
    await manager.restore(readSessionId(request)!);
    return reply.code(200).send({ sessionId: readSessionId(request), resumed: true });
  }));
  app.delete('/api/sessions/:sessionId', async (request, reply) => handleError(reply, async () => {
    await run(request, 'delete', async (session) => { manager.removeReserved(readSessionId(request)!, session); });
    return reply.code(204).send();
  }));
}

/**
 * 将会话容量和过期错误转换成不含敏感数据的 HTTP 响应。
 * 未知错误继续交给 Fastify 的统一错误处理器。
 * @param reply - Fastify 响应
 * @param action - 待执行的路由操作
 * @returns 成功结果或稳定错误响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export async function handleError<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | FastifyReply> {
  try { return await action(); } catch (error) {
    if (error instanceof SessionError) return reply.code(error.status).send({ status: 'failed', reasonCode: error.reasonCode });
    throw error;
  }
}
