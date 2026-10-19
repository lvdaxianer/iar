/** 真实 HTTP 隔离测试共享的服务与队列探针。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { startSandboxServer, type SandboxServerOptions } from '../../../examples/agent-sandbox/src/server.js';
import { SandboxSessionManager } from '../../../examples/agent-sandbox/src/session-manager.js';

/** 启动真实服务，使用临时端口避免不同测试进程之间冲突。
 * 会话限制由调用方选择，未指定时沿用生产默认值。
 * 端口探针先释放，随后服务绑定同一端口；绑定失败仍由测试报告。
 * 测试调用方负责关闭返回的服务，包含失败和断言异常路径。
 * @param sessionLimits - 场景需要覆盖的会话资源上限
 * @returns 提供独立和兼容入口的服务句柄
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export async function startConfirmationServer(sessionLimits?: SandboxServerOptions['sessionLimits']) {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return startSandboxServer({ mode: 'scripted', port: address.port, ...(sessionLimits ? { sessionLimits } : {}) });
}

/** 观察请求头预约、取消和读取排队，避免依靠定时猜测执行顺序。
 * 测试结束必须恢复原方法，避免影响同一进程里的其他场景。
 * reserved 对应请求头抵达，reading 对应已解析读取进入队列。
 * cancelled 表示传输通知预约取消，而非仅客户端调用 destroy。
 * 包装器仍转发真实预约操作，不改变其调度或容量语义。
 * @returns 可等待的事件及恢复函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export function observeReservations() {
  const reserved = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const original = SandboxSessionManager.prototype.reserve;
  SandboxSessionManager.prototype.reserve = function (...args) {
    const reservation = original.apply(this, args);
    reserved.resolve();
    return {
      run: (operation, action) => { if (operation === 'read') reading.resolve(); return reservation.run(operation, action); },
      cancel: () => { reservation.cancel(); cancelled.resolve(); }
    };
  };
  return { reserved: reserved.promise, cancelled: cancelled.promise, reading: reading.promise,
    restore: () => { SandboxSessionManager.prototype.reserve = original; } };
}
