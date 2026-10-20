/** 注册沙箱 HTTP 入口，并把预约、生命周期和会话操作委托给独立模块。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SandboxSessionManager, type Operation } from './session-manager.js';
import { registerSessionLifecycleRoutes } from './http-lifecycle-routes.js';
import { registerSessionRoutes } from './http-session-routes.js';
import { registerPiBridgeRoutes } from './http-pi-bridge-routes.js';
import { createReservationState, registerReservationHooks, type RunOperation } from './http-reservation.js';
import type { IarSandboxSession } from './session.js';

/**
 * 同会话请求共享一份预约状态，避免路由模块各自维护队列。
 * 路由拆分只改变文件边界，不改变统一错误和顺序控制。
 * 请求生命周期钩子在所有业务路由注册前安装，确保慢请求也遵循接收顺序。
 * 兼容入口和独立入口共用同一个 RunOperation 类型，避免行为分叉。
 * @param app - Fastify 服务
 * @param manager - 会话管理器
 * @param indexHtml - 自包含页面内容
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
/**
 * 为已有会话注册 HTTP 路由。
 * @param app - 沙箱 HTTP 服务
 * @param manager - 会话管理器
 * @param indexHtml - 静态页面内容
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function registerSandboxRoutes(app: FastifyInstance, manager: SandboxSessionManager, indexHtml: string): void {
  const state = createReservationState(manager);
  registerReservationHooks(app, state);
  const run: RunOperation = <T>(request: FastifyRequest, operation: Operation, action: (session: IarSandboxSession) => Promise<T>) => {
    state.clearTimer(request);
    return state.reservations.get(request)!.run(operation, action);
  };
  registerSessionLifecycleRoutes(app, { manager, run, indexHtml });
  registerSessionRoutes(app, run, '/api');
  registerSessionRoutes(app, run, '/api/sessions/:sessionId');
  registerPiBridgeRoutes(app, manager, run);
}
