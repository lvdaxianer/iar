/** 注册默认兼容入口和独立会话的聊天、确认、压缩、状态及重置操作。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { streamTurn } from './http-stream-transport.js';
import { handleError } from './http-lifecycle-routes.js';
import { asRecord, readSessionId, type RunOperation } from './http-reservation.js';
import type { Operation } from './session-manager.js';

const MAX_MESSAGE_LENGTH = 4096;
// 消息长度按 UTF-16 代码单元限制，与前端输入边界保持一致。
// 读取状态和空消息不增加 mutate 操作计数。
// 高风险确认仍由会话工作流决定，HTTP 层不提前执行插件。
// 兼容路径保留旧响应结构，独立路径只增加会话隔离所需的前缀。

/** 聊天请求限制在入口处执行，防止大正文进入模型和会话队列。 */
/** 业务操作由 RunOperation 统一串行，路由函数不直接持有会话可变状态。 */
/** 确认请求只传递用户选择和已展示的动作标识，不接受客户端改写动作内容。 */
/** 流式响应沿用同一预约，客户端断开时仍由服务端安全收束。 */
/** 空消息使用无副作用读操作返回，避免消耗会话操作预算。 */

/**
 * 为兼容入口和独立会话注册同一组业务操作。
 * 两种入口只在路径参数和确认校验上有差异，业务执行保持一致。
 * @param app - Fastify 服务
 * @param run - 会话顺序执行器
 * @param prefix - 路由前缀
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function registerSessionRoutes(app: FastifyInstance, run: RunOperation, prefix: string): void {
  app.post(`${prefix}/chat`, async (request, reply) => handleError(reply, async () => {
    const body = asRecord(request.body); const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return run(request, 'read', async () => ({ status: 'failed', reply: '消息不能为空。', reasonCode: 'empty_message' }));
    if (message.length > MAX_MESSAGE_LENGTH) return run(request, 'read', async () => reply.code(413).send({ status: 'failed', reasonCode: 'message_too_long' }));
    return run(request, 'mutate', async (session) => wantsStream(request, body) ? streamTurn(session, message, reply) : session.turn(message));
  }));
  app.post(`${prefix}/confirm`, async (request, reply) => handleError(reply, () => confirmRequest(request, run)));
  app.post(`${prefix}/compact`, async (request, reply) => handleError(reply, () => run(request, 'mutate', (session) => session.compact())));
  app.get(`${prefix}/state`, async (request, reply) => handleError(reply, () => run(request, 'read', (session) => session.state())));
  app.post(`${prefix}/reset`, async (request, reply) => handleError(reply, () => run(request, 'reset', async (session) => { await session.reset(); return { ok: true }; })));
}

/**
 * 将独立会话确认绑定到客户端看到的 actionId。
 * 兼容入口保留旧的布尔确认行为，避免影响已有调用方。
 * @param request - 当前 HTTP 请求
 * @param run - 会话顺序执行器
 * @returns 确认结果 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function confirmRequest(request: FastifyRequest, run: RunOperation): Promise<unknown> {
  const body = asRecord(request.body); const accepted = body.accepted === true; const kind = accepted ? 'confirm' : 'cancel';
  const operation: Operation = readSessionId(request) === undefined ? kind : { kind, actionId: body.actionId, accepted: body.accepted };
  return run(request, operation, (session) => session.confirm(accepted));
}

/**
 * 读取 body 或 query 中的流式开关。
 * body 显式开启时优先于查询参数，默认使用普通响应。
 * @param request - 当前 HTTP 请求
 * @param body - 已解析请求体
 * @returns 是否使用 SSE
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function wantsStream(request: FastifyRequest, body: Record<string, unknown>): boolean {
  if (body.stream === true) return true;
  const query = asRecord(request.query);
  return query.stream === '1' || query.stream === 'true';
}
