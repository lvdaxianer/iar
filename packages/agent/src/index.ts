/**
 * 提供 IAR 的统一 Agent 入口，集中安装 Plugin 包并派生 Function 索引。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { ContractValidationError, type PluginManifest } from '@iar/contracts';
import { FunctionRegistry, PluginHost, type PluginPackage, type PluginRecord } from '@iar/plugins';

/** Agent 初始化输入。 */
export type IarAgentOptions = {
  plugins: readonly PluginPackage[];
};

/** 初始化完成后的统一 IAR 运行时入口。 */
export type IarAgent = {
  pluginHost: PluginHost;
  functionRegistry: FunctionRegistry;
};

/**
 * 原子安装并启用一组 Plugin 包，返回共享的 PluginHost 和 FunctionRegistry。
 *
 * @param options - Agent 初始化配置
 * @returns 统一运行时入口
 * @throws {ContractValidationError} Plugin 列表为空或安装/启用失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function createIarAgent(options: IarAgentOptions): IarAgent {
  if (!Array.isArray(options.plugins) || options.plugins.length === 0) throw new ContractValidationError('IAR Agent 至少需要一个 Plugin 包');
  const pluginHost = new PluginHost();
  const installed = pluginHost.installAll([...options.plugins]);
  if (!installed.ok) throw new ContractValidationError(installed.error.message, [], installed.error.code);
  for (const plugin of installed.value) {
    const enabled = pluginHost.enable(plugin.manifest.pluginId);
    if (!enabled.ok) {
      rollbackInstalled(pluginHost, installed.value);
      throw new ContractValidationError(enabled.error.message, [], enabled.error.code);
    }
  }
  const functionRegistry = new FunctionRegistry(() => pluginHost.all());
  return { pluginHost, functionRegistry };
}

/** 初始化失败时清理本次事务已经安装的 Plugin 记录。 */
function rollbackInstalled(pluginHost: PluginHost, records: readonly PluginRecord[]): void {
  for (const record of [...records].reverse()) {
    const current = pluginHost.get(record.manifest.pluginId);
    if (!current) continue;
    if (current.state === 'enabled') pluginHost.disable(record.manifest.pluginId);
    const afterDisable = pluginHost.get(record.manifest.pluginId);
    if (afterDisable?.state === 'disabled') pluginHost.unload(record.manifest.pluginId);
    else if (afterDisable?.state === 'installed') pluginHost.discardInstalled(record.manifest.pluginId);
  }
}

/** 允许调用方在需要时复用 Manifest 类型而不直接依赖 contracts 包。 */
export type { PluginManifest };
