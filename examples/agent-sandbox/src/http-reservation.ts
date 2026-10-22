/** 在请求体解析前预约同会话顺序，并在断开时取消未开始操作。 */
/**
 * 预约发生在 Fastify body parser 之前，因此接收顺序先于 JSON 解析速度。
 * 客户端断开只取消尚未开始的节点；已经进入业务执行的动作继续由 drain 等待。
 * 失败响应使用固定 reasonCode，避免把请求正文或会话标识写入错误响应。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SandboxSessionManager, SessionError, type Operation } from './session-manager.js';
import type { IarSandboxSession } from './session.js';

const BODY_TIMEOUT_MS = 5_000;
// 请求体超时是资源保护边界，不代表已开始的业务动作可以被强制中断。
// 预约句柄只允许运行一次，重复调用会转换为固定请求超时错误。
// 删除预约会先阻止后续请求，再等待同会话中的已接收操作排空。
// 所有清理回调均设计为幂等，兼容 aborted、close 和 onError 的重复通知。
// 路由模块只接收稳定的 reasonCode，不记录原始请求体。
/** 业务操作必须等请求体完成解析后才能进入会话队列。 */
export type RunOperation = <T>(request: FastifyRequest, operation: Operation, action: (session: IarSandboxSession) => Promise<T>) => Promise<T>;
/**
 * 每个 HTTP 请求的预约、取消和超时状态。
 * reservations 绑定请求对象，避免将会话标识暴露到日志或跨请求缓存。
 * timers 只负责请求体阶段，业务完成后由调用方主动清理。
 */
export type ReservationState = {
  manager: SandboxSessionManager;
  reservations: WeakMap<FastifyRequest, ReturnType<SandboxSessionManager['reserve']>>;
  timers: WeakMap<FastifyRequest, NodeJS.Timeout>;
  clearTimer: (request: FastifyRequest) => void;
};
/**
 * onRequest 钩子的参数对象，避免路由层继续扩张位置参数。
 * state 与请求生命周期一起传递，便于错误路径保持相同的取消语义。
 */
type ReserveRequestOptions = { state: ReservationState; request: FastifyRequest; reply: FastifyReply; done: (error?: Error) => void };
/**
 * 未开始预约的取消参数对象。
 * 只有尚未进入执行状态的节点可以被移除并立即归还容量。
 */
type CancellationOptions = { state: ReservationState; request: FastifyRequest; reply: FastifyReply; reservation: ReturnType<SandboxSessionManager['reserve']> };

/**
 * 创建请求预约状态，集中管理定时器清理。
 * @param manager - 会话管理器
 * @returns 当前 HTTP 服务的预约状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
/** 该状态对象只属于一个 Fastify 实例，不能跨服务复用。 */
export function createReservationState(manager: SandboxSessionManager): ReservationState {
  const timers = new WeakMap<FastifyRequest, NodeJS.Timeout>();
  return { manager, reservations: new WeakMap(), timers, clearTimer: (request) => { clearTimeout(timers.get(request)); } };
}

/**
 * 注册 Fastify 请求生命周期钩子。
 * @param app - Fastify 服务
 * @param state - 请求预约状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
/** onError 与原始请求断开都走同一个幂等 cancel 路径。 */
export function registerReservationHooks(app: FastifyInstance, state: ReservationState): void {
  app.addHook('onRequest', (request, reply, done) => reserveRequest({ state, request, reply, done }));
  app.addHook('onError', (request, _reply, _error, done) => { state.clearTimer(request); state.reservations.get(request)?.cancel(); done(); });
}

/**
 * 在请求体解析前预约路由，保证慢请求不能越过同会话前序请求。
 * @param options - 请求、响应和预约状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function reserveRequest(options: ReserveRequestOptions): void {
  const { state, request, reply, done } = options; const route = request.routeOptions.url ?? '';
  const deleting = request.method === 'DELETE' && route === '/api/sessions/:sessionId';
  if (!deleting && !/^\/api(?:\/sessions\/:sessionId)?\/(?:chat|confirm|compact|state|reset)$/.test(route) && !/^\/api\/bridge\/v1\/sessions\/:sessionId\/(?:input|input\/stream|confirm|state)$/.test(route)) { done(); return; }
  try {
    const reservation = state.manager.reserve(readSessionId(request), deleting);
    state.reservations.set(request, reservation);
    registerCancellation({ state, request, reply, reservation });
    done();
  } catch (error) {
    if (error instanceof SessionError) { void reply.code(error.status).send({ status: 'failed', reasonCode: error.reasonCode }); return; }
    done(error as Error);
  }
}

/**
 * 为未开始预约设置请求体超时和客户端断开清理。
 * @param options - 请求、响应和预约句柄
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function registerCancellation(options: CancellationOptions): void {
  const { state, request, reply, reservation } = options;
  const timer = setTimeout(() => {
    reservation.cancel();
    if (!reply.sent) { reply.raw.once('finish', () => request.raw.destroy()); void reply.code(408).send({ status: 'failed', reasonCode: 'request_timeout' }); }
  }, BODY_TIMEOUT_MS);
  timer.unref(); state.timers.set(request, timer);
  request.raw.once('aborted', () => { state.clearTimer(request); reservation.cancel(); });
  reply.raw.once('close', () => { state.clearTimer(request); reservation.cancel(); });
}

/**
 * 读取路由参数中的会话标识。
 * 默认兼容入口没有参数，因此返回 undefined 并使用兼容会话。
 * @param request - 当前 Fastify 请求
 * @returns 会话标识或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function readSessionId(request: FastifyRequest): string | undefined {
  const params = asRecord(request.params);
  return typeof params.sessionId === 'string' ? params.sessionId : undefined;
}

/**
 * 将未知输入安全收窄为普通对象。
 * 数组、null 和原型对象都不作为请求字段容器使用。
 * @param value - 待收窄的未知值
 * @returns 普通对象或空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
