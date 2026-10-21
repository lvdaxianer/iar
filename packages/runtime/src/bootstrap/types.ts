/** 定义独立 IAR Runtime 的公共初始化边界。 */
import type { FunctionRegistry, PluginHost, PluginPackage } from '@iar/plugins';
import type { AsyncDecisionAdapter } from '../routing.js';

/** 独立 Runtime 的初始化配置。 */
export type IarRuntimeOptions = {
  /** 本次 Runtime 要原子安装并启用的 Plugin 包。 */
  plugins: readonly PluginPackage[];
  /** 意图决策适配器；Runtime 只持有协议，不拥有模型或宿主实现。 */
  decisionProvider: AsyncDecisionAdapter;
};

/** 初始化完成后的独立 IAR Runtime。 */
export type IarRuntime = {
  /** 当前 Runtime 所有 Plugin 的生命周期宿主。 */
  pluginHost: PluginHost;
  /** 随 Plugin 生命周期实时更新的 Function 索引。 */
  functionRegistry: FunctionRegistry;
  /** 调用方注入的意图决策适配器。 */
  decisionProvider: AsyncDecisionAdapter;
};

/** @deprecated 请使用 IarRuntimeOptions。 */
export type IarAgentOptions = IarRuntimeOptions;

/** @deprecated 请使用 IarRuntime。 */
export type IarAgent = IarRuntime;
