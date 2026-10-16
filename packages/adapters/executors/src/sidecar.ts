/**
 * 提供 Sidecar mode 的薄适配器，消息边界与 Worker/container 完全相同。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ConstrainedExecutor } from './core.js';
import type { ExecutorOptions, PluginExecutor } from './types.js';

/** @param options - 资源、能力和 cleanup 配置 @returns Sidecar executor @author lvdaxianer@yeah.net @date 2026-10-17 */
export function createSidecarExecutor(options: ExecutorOptions): PluginExecutor {
  return new ConstrainedExecutor('sidecar', options);
}
