/**
 * 提供 Worker mode 的薄适配器，执行语义全部由 ConstrainedExecutor 承担。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ConstrainedExecutor } from './core.js';
import type { ExecutorOptions, PluginExecutor } from './types.js';

/** @param options - 资源、能力和 cleanup 配置 @returns Worker executor @author lvdaxianer@yeah.net @date 2026-10-17 */
export function createWorkerExecutor(options: ExecutorOptions): PluginExecutor {
  return new ConstrainedExecutor('worker', options);
}
