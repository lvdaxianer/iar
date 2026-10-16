/**
 * 定义 Function 与 PluginManifest 共享的基础 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { IAR_API_VERSION, SCHEMA_VERSIONS } from './versions.js';

/** API 版本固定宿主与插件之间的兼容边界。 */
export const apiVersion = Type.Literal(IAR_API_VERSION);

/** JSON Schema 文档允许扩展关键字，由 Ajv 负责语义校验。 */
export const JsonSchemaSchema = Type.Record(Type.String(), Type.Unknown());

// Manifest 只检查文档外壳，完整语义由 Ajv meta-schema 校验。
// 允许插件携带标准草案未覆盖的自定义关键字。
// 非对象值会在 TypeBox 外层校验阶段被拒绝。

/** JSON 值 Schema 与 JsonValue 类型保持递归一致。 */
export const JsonValueSchema = Type.Recursive((self) => Type.Union([
  // 基本 JSON 原子值保持原生类型。
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  // 数组和对象递归引用自身，拒绝函数等运行时对象。
  Type.Array(self),
  Type.Record(Type.String(), self)
]), { $id: 'https://iar.dev/schema/json-value/v1' });

/** 风险级别用于后续 Policy Gate 和确认判断。 */
export const RiskLevelSchema = Type.Union([
  // low 表示低风险动作。
  Type.Literal('low'),
  // medium 表示需要普通策略检查的动作。
  Type.Literal('medium'),
  // high 表示外部副作用或破坏性动作。
  Type.Literal('high'),
  // critical 表示需要更强审批边界的动作。
  Type.Literal('critical')
]);

/** Function 的路由和输入输出边界。 */
export const FunctionDefinitionSchema = Type.Object({
  // 版本字段用于兼容性判断。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.function),
  // Function ID 是插件归属的稳定边界。
  functionId: Type.String({ minLength: 1 }),
  // Function 版本用于固定行为。
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
  // 名称和描述供宿主展示与审计。
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  // 输入输出 Schema 是 Function 的数据边界。
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  // 能力和风险供路由、策略过滤。
  capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  riskLevel: RiskLevelSchema
}, { additionalProperties: false });

/** 插件策略元数据，安装时固定。 */
export const PluginPolicyMetadataSchema = Type.Object({
  // 风险等级必须在安装时固定。
  riskLevel: RiskLevelSchema,
  // 破坏性动作要求显式确认。
  requiresConfirmation: Type.Boolean(),
  // 允许能力用于限制副作用范围。
  allowedCapabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })
}, { additionalProperties: false });

/** 插件生命周期入口，供宿主驱动加载和卸载。 */
export const PluginLifecycleSchema = Type.Object({
  // entrypoint 是宿主加载插件的入口。
  entrypoint: Type.String({ minLength: 1 }),
  // 以下入口是可选生命周期钩子。
  onLoad: Type.Optional(Type.String({ minLength: 1 })),
  onEnable: Type.Optional(Type.String({ minLength: 1 })),
  onDisable: Type.Optional(Type.String({ minLength: 1 })),
  onUnload: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** 业务和系统插件共用的 Manifest 字段。 */
export const pluginManifestFields = {
  // API 版本控制宿主与插件的兼容边界。
  apiVersion,
  // Manifest 版本控制字段演进。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.pluginManifest),
  // pluginId 是注册表中的稳定标识。
  pluginId: Type.String({ minLength: 1 }),
  // version 用于固定执行实现和回滚。
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$' }),
  // description 供宿主审计和候选展示。
  description: Type.String({ minLength: 1 }),
  // capabilities 不能由模型决策动态增加。
  capabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  // 插件输入输出必须有明确 Schema 文档。
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  // lifecycle 保持宿主与插件解耦。
  lifecycle: PluginLifecycleSchema,
  // policy 供 Policy Gate 使用。
  policy: PluginPolicyMetadataSchema,
  // dependencies 用于确定性加载排序。
  dependencies: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })
};

// 公共字段集中定义，避免两个 Manifest 变体发生漂移。
// 业务与系统变体只补充各自的 kind 和 scope。
// 其余字段始终从同一份公共定义继承。

/** 具有唯一 Function 归属的业务插件 Manifest。 */
export const FunctionPluginManifestSchema = Type.Object({
  // 业务插件必须声明 Function 归属。
  ...pluginManifestFields,
  // functionId 是业务插件可路由性的硬约束。
  pluginKind: Type.Literal('function'),
  scope: Type.Literal('function'),
  functionId: Type.String({ minLength: 1 })
}, { additionalProperties: false });

/** 通过 Hook/订阅运行且不参与业务路由的系统插件。 */
export const SystemPluginManifestSchema = Type.Object({
  // 系统插件复用完整生命周期和策略字段。
  ...pluginManifestFields,
  pluginKind: Type.Literal('system'),
  // runtime 与现有内置日志插件基线一致。
  scope: Type.Literal('runtime')
}, { additionalProperties: false });

/** 所有可安装插件的联合 Schema。 */
export const PluginManifestSchema = Type.Union([
  FunctionPluginManifestSchema,
  SystemPluginManifestSchema
]);

// pluginKind 和 scope 共同隔离业务插件与系统插件。
// 该联合结构阻止系统插件被误认为业务实现。
