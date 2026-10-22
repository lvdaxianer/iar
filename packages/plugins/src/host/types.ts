/**
 * 定义 PluginHost 的注册记录、状态和返回值类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ActionType, ContractErrorResult, EventEnvelope, FunctionDefinition, JsonValue, PluginManifest, PluginOperation, RiskLevel } from '@iar/contracts';
import type { FunctionHandler, PluginPackage } from '../sdk/index.js';

/**
 * 插件注册表支持的生命周期状态。
 *
 * discovered/validated 是安装事务中的瞬态事件状态；
 * installed 之后的状态才会保留在当前注册表中；
 * unloaded 表示当前能力已撤销且不再出现在注册表中。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginState = 'discovered' | 'validated' | 'installed' | 'enabled' | 'draining' | 'disabled' | 'unloaded';

/**
 * 注册表中的当前插件记录，从安装成功后的 installed 状态开始持久存在。
 *
 * @property manifest - 通过契约校验且已深拷贝的插件声明
 * @property state - 当前可路由生命周期状态
 * @property functions - 由 Plugin 包拥有的 Function 执行记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginRecord = {
  manifest: PluginManifest;
  state: Exclude<PluginState, 'unloaded'>;
  functions: ReadonlyMap<string, PluginFunctionRecord>;
};

/** PluginRecord 中的 Function 执行快照。 */
export type PluginFunctionRecord = {
  definition: FunctionDefinition;
  operations: readonly PluginOperation[];
  handler: FunctionHandler;
};

/** 提供给模型或选择层的通用 Plugin 能力描述，不包含执行权限。 */
export type PluginDescriptor = {
  /** 当前候选的稳定不透明键，用于跨模型传递选择。 */
  candidateKey: string;
  /** 声明该能力归属的 Function。 */
  functionId: string;
  /** 声明该能力实现的 Plugin。 */
  pluginId: string;
  /** Manifest 提供的自然语言描述。 */
  description: string;
  /** Manifest 声明的动作类型。 */
  actionTypes: ActionType[];
  /** Plugin 的固定能力权限集合。 */
  capabilities: string[];
  /** 模型可理解的操作元数据，不等于执行授权。 */
  operationMetadata: {
    actionTypes: ActionType[];
    capabilities: string[];
    riskLevel: RiskLevel;
    requiresConfirmation: boolean;
    operations: PluginOperation[];
  };
};

/** 描述投影的授权边界。 */
export type PluginDescriptorOptions = {
  authorize?: (record: PluginRecord) => boolean;
};

/** 提供给第一阶段语义抽取的 Plugin 级描述，不暴露 Function 级候选。 */
export type PluginScopeDescriptor = {
  candidateKey: string;
  pluginId: string;
  description: string;
  actionTypes: ActionType[];
  capabilities: string[];
};

/** 选中 Plugin 后投影给 Function Calling 的单个 Operation 工具。 */
export type PluginFunctionToolDescriptor = {
  name: string;
  pluginId: string;
  functionId: string;
  description: string;
  parameters: JsonValue;
  operation?: string;
};

/**
 * PluginHost 接受完整 Plugin 包；仅 system Manifest 可作为无业务 Handler 的生命周期输入。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginInstallInput = PluginPackage | PluginManifest;

/**
 * PluginHost 的成功或稳定错误结果。
 *
 * @template T - 成功分支携带的值类型
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginHostResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorResult };

/**
 * PluginHost 构造生命周期事件所需的最小信息。
 *
 * @property eventName - 版本化插件事件名称
 * @property pluginId - 事件所属插件
 * @property functionId - 业务插件的 Function 归属
 * @property from - 可选前置状态
 * @property to - 可选目标状态
 * @property reasonCode - 可选拒绝错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PluginEventInput = {
  eventName: Extract<EventEnvelope['eventName'], `plugin.${string}`>;
  pluginId: string;
  functionId?: string;
  from?: PluginState;
  to?: PluginState;
  reasonCode?: string;
};
