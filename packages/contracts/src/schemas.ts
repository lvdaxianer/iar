/**
 * 汇总并公开 IAR 的版本化 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { TSchema } from '@sinclair/typebox';
import {
  // Action 请求 Schema。
  ActionDefinitionSchema,
  // Action 结果 Schema。
  ActionResultSchema,
  // BehaviorContext 状态 Schema。
  BehaviorContextSchema,
  // 结构化 Decision Schema。
  DecisionResultSchema,
  // 稳定错误结果 Schema。
  ErrorResultSchema,
  // EventLog 事件外壳 Schema。
  EventEnvelopeSchema,
  // 有限事件名称 Schema。
  EventNameSchema,
  // 主语来源 Schema。
  SubjectReferenceSchema,
  // 槽位值 Schema。
  SlotValueSchema,
  // 工作流投影 Schema。
  BehaviorWorkflowSchema,
  // 待处理输入 Schema。
  PendingInputSchema,
  // 确认状态 Schema。
  ConfirmationStateSchema
} from './schema-state.js';
import {
  // 规则原子条件 Schema。
  RuleConditionSchema,
  // 路由规则 Schema。
  RuleDefinitionSchema,
  // 递归规则表达式 Schema。
  RuleExpressionSchema,
  // 工作流定义 Schema。
  WorkflowDefinitionSchema,
  // 状态转移 Schema。
  WorkflowTransitionSchema
} from './schema-routing.js';
import {
  // Function 定义 Schema。
  FunctionDefinitionSchema,
  // 业务插件 Manifest Schema。
  FunctionPluginManifestSchema,
  // 嵌入 JSON Schema 外壳。
  JsonSchemaSchema,
  // 递归 JSON 值 Schema。
  JsonValueSchema,
  // 插件生命周期 Schema。
  PluginLifecycleSchema,
  // Manifest 联合 Schema。
  PluginManifestSchema,
  // 插件策略 Schema。
  PluginPolicyMetadataSchema,
  // 风险等级 Schema。
  RiskLevelSchema,
  // 系统插件 Manifest Schema。
  SystemPluginManifestSchema
} from './schema-primitives.js';

/** 汇总所有公共 Schema，供验证器按稳定名称查找。 */
export const CONTRACT_SCHEMAS = {
  // Action 请求和结果。
  action: ActionDefinitionSchema,
  actionResult: ActionResultSchema,
  // 事件投影状态。
  behaviorContext: BehaviorContextSchema,
  // 模型和规则决策。
  decision: DecisionResultSchema,
  // 稳定错误边界。
  error: ErrorResultSchema,
  // 不可变事实事件。
  event: EventEnvelopeSchema,
  // Function 路由能力。
  function: FunctionDefinitionSchema,
  // 可安装插件能力。
  pluginManifest: PluginManifestSchema,
  // Function/Plugin 规则。
  rule: RuleDefinitionSchema,
  // 本地工作流状态机。
  workflow: WorkflowDefinitionSchema
} as const satisfies Record<string, TSchema>;

// 验证器只从该映射取得公共 Schema，避免散落的动态名称。
// 映射键同时作为 validateContract 的公共 API。
// 新增契约必须先登记在这里再暴露给验证器。
// Schema 名称保持小写，便于日志和 fixture 对齐。
// 该映射不包含内部辅助 Schema，避免误把 JSON 值当公共对象。
// 适配器依赖公开导出而不依赖其他包内部实现。
// 这样可以保持 Embedded、Service 和 Sidecar 的契约入口一致。

/** 重新导出基础 Schema，保持原有契约包入口稳定。 */
export {
  // 基础能力和插件 Manifest。
  FunctionDefinitionSchema,
  FunctionPluginManifestSchema,
  JsonSchemaSchema,
  JsonValueSchema,
  PluginLifecycleSchema,
  PluginManifestSchema,
  PluginPolicyMetadataSchema,
  RiskLevelSchema,
  SystemPluginManifestSchema
};

/** 重新导出路由 Schema，供规则和工作流适配器复用。 */
export {
  // 路由与工作流。
  RuleConditionSchema,
  RuleDefinitionSchema,
  RuleExpressionSchema,
  WorkflowDefinitionSchema,
  WorkflowTransitionSchema
};

/** 重新导出状态与事件 Schema，供存储和运行时复用。 */
export {
  // Action、状态与事件。
  ActionDefinitionSchema,
  ActionResultSchema,
  BehaviorContextSchema,
  BehaviorWorkflowSchema,
  ConfirmationStateSchema,
  DecisionResultSchema,
  ErrorResultSchema,
  EventEnvelopeSchema,
  EventNameSchema,
  PendingInputSchema,
  SlotValueSchema,
  SubjectReferenceSchema
};
