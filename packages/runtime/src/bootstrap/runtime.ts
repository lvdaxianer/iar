/** 提供独立 IAR Runtime 的原子初始化入口。 */
import { ContractValidationError, type PluginManifest } from '@iar/contracts';
import { FunctionRegistry, PluginHost, SELF_INTRODUCTION_PLUGIN_ID, SELF_INTRODUCTION_MAX_PROMPT_LENGTH, selfIntroductionPlugin, type PluginPackage, type PluginRecord } from '@iar/plugins';
import type { IarRuntime, IarRuntimeConfiguration, IarRuntimeOptions } from './types.js';

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

  const configuration = normalizeConfiguration(options, [...options.plugins.filter((plugin) => plugin.manifest.pluginId !== SELF_INTRODUCTION_PLUGIN_ID), selfIntroductionPlugin]);
  const pluginHost = new PluginHost();
  const installed = pluginHost.installAll(selectPlugins(options.plugins, configuration.disabledPluginIds));
  if (!installed.ok) throw new ContractValidationError(installed.error.message, [], installed.error.code);

  for (const plugin of installed.value) {
    const enabled = pluginHost.enable(plugin.manifest.pluginId);
    if (!enabled.ok) {
      rollbackInstalled(pluginHost, installed.value);
      throw new ContractValidationError(enabled.error.message, [], enabled.error.code);
    }
  }

  const functionRegistry = new FunctionRegistry(() => pluginHost.all());
  return { pluginHost, functionRegistry, decisionProvider: options.decisionProvider, configuration };
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

/** 初始化失败时清理本次事务已经安装的 Plugin 记录。
 *
 * @param pluginHost - 本次初始化创建的 PluginHost
 * @param records - 已完成安装的 Plugin 记录
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
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

/** 校验并保存 Agent 创建配置，配置快照不保留调用方可变数组引用。
 *
 * @param options - Agent 创建输入
 * @param availablePlugins - 可被关闭的完整 Plugin 集合
 * @returns 不可变配置快照
 * @throws {ContractValidationError} 关闭项或提示词越过配置边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function normalizeConfiguration(options: IarRuntimeOptions, availablePlugins: readonly PluginPackage[]): IarRuntimeConfiguration {
  if (options.disabledPluginIds !== undefined && !Array.isArray(options.disabledPluginIds)) throw new ContractValidationError('disabledPluginIds 必须是数组');
  const disabledPluginIds = [...(options.disabledPluginIds ?? [])];
  const availableIds = new Set(availablePlugins.map((plugin) => plugin.manifest.pluginId));
  if (new Set(disabledPluginIds).size !== disabledPluginIds.length || disabledPluginIds.some((id) => typeof id !== 'string' || id.length === 0)) throw new ContractValidationError('disabledPluginIds 必须是唯一的非空 Plugin 标识');
  if (disabledPluginIds.includes(SELF_INTRODUCTION_PLUGIN_ID)) throw new ContractValidationError('内置自我介绍 Plugin 不允许关闭');
  if (disabledPluginIds.some((id) => !availableIds.has(id))) throw new ContractValidationError('disabledPluginIds 包含未注册 Plugin');
  const extraPrompt = options.selfIntroduction?.extraPrompt;
  if (extraPrompt !== undefined && (typeof extraPrompt !== 'string' || extraPrompt.length > SELF_INTRODUCTION_MAX_PROMPT_LENGTH)) throw new ContractValidationError('自我介绍额外提示词超过长度限制');
  return { disabledPluginIds: Object.freeze(disabledPluginIds), selfIntroduction: Object.freeze(extraPrompt === undefined ? {} : { extraPrompt }) };
}

/** 追加内置自我介绍 Plugin，并过滤创建时明确关闭的外部 Plugin。
 *
 * @param plugins - 调用方提交的外部 Plugin 包
 * @param disabledPluginIds - 创建时明确关闭的 Plugin 标识
 * @returns 实际进入安装事务的 Plugin 包
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function selectPlugins(plugins: readonly PluginPackage[], disabledPluginIds: readonly string[]): PluginPackage[] {
  const disabled = new Set(disabledPluginIds);
  const selected = plugins.filter((plugin) => plugin.manifest.pluginId !== SELF_INTRODUCTION_PLUGIN_ID && !disabled.has(plugin.manifest.pluginId));
  selected.push(selfIntroductionPlugin);
  return selected;
}

/** 允许 Runtime 调用方复用 Manifest 类型而不直接依赖 contracts 包。 */
export type { PluginManifest, PluginPackage };
