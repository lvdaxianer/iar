/**
 * 定义 Function、PluginManifest 与基础 JSON 类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { IarApiVersion } from './versions.js';

/** 可安全写入事件和 Action 的递归 JSON 值。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 嵌入式 JSON Schema 文档，具体语义由 Ajv 校验。 */
export type JsonSchema = Record<string, unknown>;

/** 允许进入通用结构化上下文的公开输出字段白名单。 */
export const TRUSTED_FACT_FIELDS = [
  'ticketId', 'receipt', 'status', 'priority', 'jobName', 'serviceId', 'datasetId', 'reportId', 'requestId', 'caseId', 'operation'
] as const;

/** 单个可信事实字符串的最大 Unicode 字符数。 */
export const MAX_TRUSTED_FACT_STRING_LENGTH = 256;

/** 单个事实键的最大长度，覆盖 Function 和字段名。 */
export const MAX_TRUSTED_FACT_KEY_LENGTH = 320;

/** 单个 BehaviorContext 允许保存的事实数量。 */
export const MAX_TRUSTED_FACTS = 64;

/** 契约中允许声明的风险等级。 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** 插件的业务或系统实现类型。 */
export type PluginKind = 'function' | 'system';

/** 插件作用域；runtime 系统插件不会进入业务候选。 */
export type PluginScope = 'function' | 'runtime';

/** Function 的路由和输入输出边界。 */
export type FunctionDefinition = {
  // Schema 版本用于兼容性判断。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.function;
  // Function ID 是插件归属的稳定边界。
  functionId: string;
  // 版本决定 Function 字段的解释方式。
  version: string;
  // 名称供宿主展示。
  name: string;
  // 描述供有限候选的解释。
  description: string;
  // 输入输出 Schema 描述 Function 数据边界。
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  // 能力和风险供路由、策略过滤。
  capabilities: string[];
  riskLevel: RiskLevel;
};

/** 插件安装时固定的策略元数据。 */
export type PluginPolicyMetadata = {
  // 风险等级在安装时固定。
  riskLevel: RiskLevel;
  // 破坏性动作是否要求确认。
  requiresConfirmation: boolean;
  // 插件获准使用的能力集合。
  allowedCapabilities: string[];
};

/** 宿主驱动插件加载、启停和卸载的入口。 */
export type PluginLifecycle = {
  // entrypoint 是宿主加载入口。
  entrypoint: string;
  // 以下字段是可选生命周期钩子。
  onLoad?: string;
  onEnable?: string;
  onDisable?: string;
  onUnload?: string;
};

/** 具有唯一 Function 归属的业务插件 Manifest。 */
export type FunctionPluginManifest = {
  // API 版本用于宿主兼容性协商。
  apiVersion: IarApiVersion;
  // Manifest 版本用于字段演进。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.pluginManifest;
  // pluginId 是注册表稳定标识。
  pluginId: string;
  // function 插件只能声明业务实现。
  pluginKind: 'function';
  // function scope 强制 Function 所有权边界。
  scope: 'function';
  // 每个业务插件必须且只能归属一个 Function。
  functionId: string;
  // 版本用于固定执行和回滚。
  version: string;
  // 描述供审计和候选展示。
  description: string;
  // 能力不能由模型动态扩展。
  capabilities: string[];
  // 输入输出 Schema 是插件调用边界。
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  lifecycle: PluginLifecycle;
  policy: PluginPolicyMetadata;
  dependencies: string[];
};

/** 通过 Hook/订阅运行且不参与业务路由的系统插件。 */
export type SystemPluginManifest = {
  // 系统插件同样受 API 版本约束。
  apiVersion: IarApiVersion;
  // 统一 Manifest Schema 版本。
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.pluginManifest;
  // 系统处理器的稳定标识。
  pluginId: string;
  // system 插件不参与业务决策。
  pluginKind: 'system';
  // runtime 与内置日志插件基线一致。
  scope: 'runtime';
  // 系统插件版本用于升级和回滚。
  version: string;
  // 描述用于系统审计。
  description: string;
  // 系统能力仍需显式声明。
  capabilities: string[];
  // 系统 Handler 的输入输出边界。
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  lifecycle: PluginLifecycle;
  policy: PluginPolicyMetadata;
  dependencies: string[];
};

/** 表示可安装的任一插件 Manifest。 */
export type PluginManifest = FunctionPluginManifest | SystemPluginManifest;
