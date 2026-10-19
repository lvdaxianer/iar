/**
 * 定义上下文压缩模型结果和 Runtime 生成事件的 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { BehaviorContextSchema, MAX_CONTEXT_SUMMARY_LENGTH } from './schema-context.js';
import { JsonValueSchema } from './schema-primitives.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** 摘要和压缩事件的长度边界。 */
export const COMPACTION_LIMITS = {
  // 单次压缩最多接收一个有界事件窗口，超出时必须失败而不是跳过事件。
  maxEvents: 128,
  // 摘要不能成为新的无限上下文。
  maxSummaryLength: MAX_CONTEXT_SUMMARY_LENGTH,
  // 引用数量限制避免模型输出放大。
  maxReferences: 128,
  // 保留事实必须是有限声明集合。
  maxFacts: 32,
  // 警告只用于审计，不承载任意日志。
  maxWarnings: 32
} as const;
// 所有限制集中定义，避免 Schema 和 Runtime 使用不同边界。
// 这些上限同时保护模型调用、内存占用和审计存储。
// 修改上限时应同步更新 Prompt 和契约测试。
// 所有数组上限均是公开协议的一部分。

/** Runtime 必须要求模型声明保留的可执行事实路径。 */
export const REQUIRED_PRESERVED_FACTS = [
  // 主语必须可恢复。
  'subject',
  // 动作阶段必须可恢复。
  'action',
  // Function 和 Plugin 路由必须固定。
  'functionId',
  'pluginId',
  'slots',
  // 工作流当前位置不能丢失。
  'workflow.currentStep',
  // 等待输入类型不能丢失。
  'pending',
  // 确认范围不能改变。
  'confirmation',
  // 意图用于恢复后续理解边界。
  'intent',
  // 幂等键用于防止重复副作用。
  'idempotencyKey',
  // 可信事实及来源必须从旧视图完整保留。
  'facts'
] as const;
// 该清单同时服务于模型提示、运行时校验和审计报告。

/** 压缩结果中的指代引用及其事实来源。 */
export const CompactionReferenceSchema = Type.Object({
  // text 是摘要中出现的原始指代。
  text: Type.String({ minLength: 1, maxLength: 300 }),
  // resolvedTo 是稳定实体或槽位值。
  resolvedTo: Type.String({ minLength: 1, maxLength: 300 }),
  // sourceEventId 必须回指 EventLog。
  sourceEventId: Type.String({ minLength: 1, maxLength: 200 })
}, { additionalProperties: false });
// 额外字段关闭，避免引用借载荷注入执行指令。
// 引用文本、目标和来源均限制长度，防止异常模型输出耗尽内存。

/** 模型返回的主语片段，允许省略 Runtime 元数据。 */
const ModelSubjectSchema = Type.Object({
  // 模型可只返回发生变化的主语字段。
  type: Type.Optional(Type.String({ minLength: 1 })),
  id: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(Type.Union([Type.Literal('resolved'), Type.Literal('unresolved')])),
  source: Type.Optional(Type.Union([
    Type.Literal('input'), Type.Literal('context'), Type.Literal('event'), Type.Literal('plugin')
  ])),
  sourceEventId: Type.Optional(Type.String({ minLength: 1 })),
  // name 只供摘要显示，不进入 BehaviorContext。
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 }))
}, { additionalProperties: false });
// subject 片段只描述事实，不包含可执行权限。
// name 作为展示信息允许存在，但不会进入规范化 BehaviorContext。

/** 模型返回的意图片段，兼容 README 和 Prompt 的两种表达。 */
const ModelIntentSchema = Type.Union([
  // README 的最小结构使用字符串意图。
  Type.String({ minLength: 1, maxLength: 300 }),
  // Prompt 示例允许带 unresolved 状态的意图对象。
  Type.Object({
    value: Type.String({ minLength: 1, maxLength: 300 }),
    status: Type.Union([Type.Literal('resolved'), Type.Literal('unresolved')])
  }, { additionalProperties: false })
]);
// intent 的两种形式最终都由 Runtime 归一化为字符串。
// 未知状态只能通过 unresolved 表达，不能删除字段逃避校验。

/** 模型返回的行为状态候选片段。 */
export const CompactionModelStateSchema = Type.Object({
  // 以下字段全部是候选片段，Runtime 会和可信上下文合并。
  subject: Type.Optional(ModelSubjectSchema),
  // intent 不能直接改变已固定路由。
  intent: Type.Optional(ModelIntentSchema),
  action: Type.Optional(Type.Object({
    // Action 名称和阶段不能越过 Projector 哈希门禁。
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    status: Type.Optional(Type.Union([
      Type.Literal('proposed'), Type.Literal('resolved'), Type.Literal('executed'), Type.Literal('failed')
    ]))
  }, { additionalProperties: false })),
  route: Type.Optional(Type.Object({
    // Function/Plugin 路由必须保持原有绑定。
    functionId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    pluginId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 }))
  }, { additionalProperties: false })),
  // slots 的键和值受长度和 JSON Schema 双重约束。
  slots: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.Object({
    // 槽位 value 必须保留显式 null/unresolved 语义。
    value: JsonValueSchema,
    status: Type.Union([Type.Literal('unresolved'), Type.Literal('resolved'), Type.Literal('confirmed')]),
    sourceEventId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 }))
  }, { additionalProperties: false }))),
  // workflow 只描述当前位置，不授予跳步权限。
  workflow: Type.Optional(Type.Object({
    // 工作流步骤是恢复执行的关键边界。
    workflowId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    currentStep: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    status: Type.Optional(Type.Union([
      Type.Literal('pending'), Type.Literal('running'), Type.Literal('waiting'),
      Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled')
    ]))
  }, { additionalProperties: false })),
  // pending 的缺失字段由可信旧状态补齐。
  pending: Type.Optional(Type.Object({
    // pending 决定下一轮输入类型。
    kind: Type.Optional(Type.Union([
      Type.Literal('slot'), Type.Literal('selection'), Type.Literal('confirmation'), Type.Literal('input')
    ])),
    status: Type.Optional(Type.Union([Type.Literal('required'), Type.Literal('received'), Type.Literal('none')])),
    options: Type.Optional(Type.Array(Type.Object({
      key: Type.String({ minLength: 1, maxLength: 60 }),
      label: Type.String({ minLength: 1, maxLength: 200 })
    }, { additionalProperties: false }), { maxItems: 12, uniqueItems: true }))
  }, { additionalProperties: false })),
  // confirmation 的 scopeHash 最终由关键字段哈希保护。
  confirmation: Type.Optional(Type.Object({
    // confirmation scope 由 Runtime 哈希保护。
    state: Type.Optional(Type.Union([
      Type.Literal('not_required'), Type.Literal('required'), Type.Literal('confirmed'), Type.Literal('rejected')
    ])),
    scopeHash: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
    confirmedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    status: Type.Optional(Type.Literal('unresolved'))
  }, { additionalProperties: false }))
}, { additionalProperties: false });
// 状态候选明确拒绝 schemaVersion 和 integrity 等 Runtime 字段。
// additionalProperties false 使候选状态不会携带隐藏执行命令。

/** contextCompactor 的最小结构化返回边界。 */
export const CompactionResultSchema = Type.Object({
  // 版本固定模型结果的解析方式。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.compactionResult),
  // summary 只用于恢复上下文，不授予执行权限。
  summary: Type.String({ minLength: 1, maxLength: COMPACTION_LIMITS.maxSummaryLength }),
  // state 不包含 integrity 等 Runtime 专属元数据。
  state: CompactionModelStateSchema,
  // references 必须由 Runtime 逐条回指事件。
  references: Type.Array(CompactionReferenceSchema, { maxItems: COMPACTION_LIMITS.maxReferences }),
  // preservedFacts 是模型对关键事实的显式声明。
  preservedFacts: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    uniqueItems: true,
    maxItems: COMPACTION_LIMITS.maxFacts
  }),
  // warnings 保留不确定性，不允许模型借此改变状态。
  warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: COMPACTION_LIMITS.maxWarnings
  })
}, { additionalProperties: false });
// Schema 层先限制形状，Runtime 层再验证跨字段关系。
// 模型结果不允许自行携带事件边界、token 或哈希。
// 边界与哈希属于 Runtime 可信输入，不应由模型伪造。

/** Runtime 生成的成功压缩事件载荷。 */
export const CompactionEventPayloadSchema = Type.Object({
  // 事件边界由 Runtime 补齐。
  fromEventId: Type.String({ minLength: 1 }),
  toEventId: Type.String({ minLength: 1 }),
  firstKeptEntryId: Type.String({ minLength: 1 }),
  // summaryVersion 标识摘要解释方式。
  // 成功载荷携带可重放摘要和完整状态。
  summary: Type.String({ minLength: 1, maxLength: COMPACTION_LIMITS.maxSummaryLength }),
  summaryVersion: Type.String({ minLength: 1, maxLength: 100 }),
  state: BehaviorContextSchema,
  // 事件引用与模型结果数组相互隔离。
  references: Type.Array(CompactionReferenceSchema, { maxItems: COMPACTION_LIMITS.maxReferences }),
  // 保留事实数组去重，避免重复声明掩盖遗漏。
  preservedFacts: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    uniqueItems: true,
    maxItems: COMPACTION_LIMITS.maxFacts
  }),
  warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: COMPACTION_LIMITS.maxWarnings }),
  // token 计数用于审计压缩效果。
  beforeTokenCount: Type.Integer({ minimum: 0 }),
  afterTokenCount: Type.Integer({ minimum: 0 }),
  // generatorVersion 使摘要生成器可回溯。
  generatorVersion: Type.String({ minLength: 1, maxLength: 100 }),
  // 哈希证明成功事件没有改变执行状态。
  criticalFieldHash: Type.String({ minLength: 1, maxLength: 128 })
}, { additionalProperties: false });
// 成功事件的关键哈希只能来自 Runtime 计算结果。
// 成功事件载荷保存完整 BehaviorContext，便于审计和重放。
// EventLog 只接收已经经过关键字段哈希校验的完整状态。
// 事件载荷不能被模型直接提交。
// 专用 Schema 由 validateContract 按 eventName 选择。

/** Runtime 生成的失败压缩事件载荷。 */
export const CompactionFailedEventPayloadSchema = Type.Object({
  // 失败原因使用稳定错误码。
  reasonCode: Type.String({ minLength: 1, maxLength: 100 }),
  // message 只提供人类可读摘要。
  message: Type.String({ minLength: 1, maxLength: 500 }),
  // previousContextHash 证明旧视图仍然有效。
  previousContextHash: Type.String({ minLength: 1, maxLength: 128 })
}, { additionalProperties: false });
// 失败载荷只说明原因和旧视图证明，不携带候选状态。
// 失败事件不应把未验证的模型状态重新写回事件日志。
// 统一失败载荷便于存储、订阅和审计模块复用。
