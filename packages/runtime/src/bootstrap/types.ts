/** 定义独立 IAR Runtime 的公共初始化边界。 */
import type { FunctionRegistry, PluginHost, PluginPackage } from '@iar/plugins';
import type { AsyncDecisionAdapter } from '../routing.js';

/** Agent 创建时可覆盖的自我介绍行为配置。 */
export type SelfIntroductionOptions = {
  /** 仅在自我介绍回复生成阶段追加的用户提示词。 */
  extraPrompt?: string;
};

/** Agent 创建时保存的不可变配置快照。 */
export type IarRuntimeConfiguration = {
  /** 创建时被显式关闭的 Plugin 标识。 */
  disabledPluginIds: readonly string[];
  /** 自我介绍能力的额外提示词配置。 */
  selfIntroduction: Readonly<SelfIntroductionOptions>;
};

/** 独立 Runtime 的初始化配置。 */
export type IarRuntimeOptions = {
  /** 本次 Runtime 要原子安装并启用的 Plugin 包。 */
  plugins: readonly PluginPackage[];
  /** 意图决策适配器；Runtime 只持有协议，不拥有模型或宿主实现。 */
  decisionProvider: AsyncDecisionAdapter;
  /** 本次 Agent 创建时固化的 Plugin 开关与提示词配置。 */
  disabledPluginIds?: readonly string[];
  /** 自我介绍 Function 的额外提示词配置。 */
  selfIntroduction?: SelfIntroductionOptions;
};

/** 初始化完成后的独立 IAR Runtime。 */
export type IarRuntime = {
  /** 当前 Runtime 所有 Plugin 的生命周期宿主。 */
  pluginHost: PluginHost;
  /** 随 Plugin 生命周期实时更新的 Function 索引。 */
  functionRegistry: FunctionRegistry;
  /** 调用方注入的意图决策适配器。 */
  decisionProvider: AsyncDecisionAdapter;
  /** 创建时保存的配置快照，供宿主和会话回复层复用。 */
  configuration: IarRuntimeConfiguration;
};

/** @deprecated 请使用 IarRuntimeOptions。 */
export type IarAgentOptions = IarRuntimeOptions;

/** @deprecated 请使用 IarRuntime。 */
export type IarAgent = IarRuntime;
