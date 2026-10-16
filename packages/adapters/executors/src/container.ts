/**
 * 提供 container mode 的薄适配器，安全 contract 不依赖具体容器 runtime。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ConstrainedExecutor } from './core.js';
import type { ExecutorOptions, PluginExecutor } from './types.js';

/** @param options - 资源、能力和 cleanup 配置 @returns container executor @author lvdaxianer@yeah.net @date 2026-10-17 */
export function createContainerExecutor(options: ExecutorOptions): PluginExecutor {
  return new ConstrainedExecutor('container', options);
}
