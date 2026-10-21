/** 提供独立 IAR Runtime 的原子初始化入口。 */
import { ContractValidationError, type PluginManifest } from '@iar/contracts';
import { FunctionRegistry, PluginHost, type PluginPackage, type PluginRecord } from '@iar/plugins';
import type { IarRuntime, IarRuntimeOptions } from './types.js';

/**
 * 原子安装并启用一组 Plugin 包，返回共享的 PluginHost 和 FunctionRegistry。
 *
 * Runtime 不加载 Pi、HTTP、数据库或 durable execution adapter；这些能力由
 * 调用方在 Runtime 外部显式装配。
 *
 * @param options - Runtime 初始化配置
 * @returns 独立 IAR Runtime
 * @throws {ContractValidationError} Plugin 列表为空或安装/启用失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function createIarRuntime(options: IarRuntimeOptions): IarRuntime {
  if (!Array.isArray(options?.plugins) || options.plugins.length === 0) {
    throw new ContractValidationError('IAR Runtime 至少需要一个 Plugin 包');
  }
  if (!options.decisionProvider || typeof options.decisionProvider.decide !== 'function') {
    throw new ContractValidationError('IAR Runtime 必须提供决策适配器');
  }

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
  return { pluginHost, functionRegistry, decisionProvider: options.decisionProvider };
}

/**
 * 迁移期间保留的旧命名别名。
 *
 * @deprecated 请使用 createIarRuntime。
 * @param options - Runtime 初始化配置
 * @returns 独立 IAR Runtime
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export const createIarAgent = createIarRuntime;

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

/** 允许 Runtime 调用方复用 Manifest 类型而不直接依赖 contracts 包。 */
export type { PluginManifest, PluginPackage };
