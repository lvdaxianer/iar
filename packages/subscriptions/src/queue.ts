/**
 * 提供异步订阅队列的微任务边界和异常收敛。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { unexpectedDispatchFailure } from './execution.js';
import type { DispatchReport } from './types.js';

/**
 * 推迟异步投递并保证异常转为稳定报告，同时维护在途计数。
 *
 * @param operation - 异步投递操作
 * @param eventId - 当前事件标识
 * @returns 延迟执行的报告 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function deferredDispatch(operation: () => Promise<DispatchReport>, eventId: string): Promise<DispatchReport> {
  return new Promise((resolve) => queueMicrotask(() => {
    void Promise.resolve().then(operation).then(resolve, () => resolve(unexpectedDispatchFailure(eventId)));
  }));
}
