/**
 * 提供 agent sandbox 十个 Function 插件的 worker 侧注册表。
 *
 * LocalWorkflow 的 ActionExecutor 是同步签名，而插件 Handler 是异步协议；
 * sandbox 通过 worker 线程执行插件，该注册表让 worker 按 pluginId 找到对应注册对象。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { PluginPackage } from '@iar/plugin';
import { selfIntroductionPlugin } from '@iar/plugins';
import { allSandboxPlugins } from '../functions/index.js';

/** pluginId 到插件注册对象的确定性映射。 */
export const sandboxPluginRegistry: Readonly<Record<string, PluginPackage>> = Object.fromEntries(
  [...allSandboxPlugins, selfIntroductionPlugin].map((registration) => [registration.manifest.pluginId, registration])
);
