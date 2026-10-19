/**
 * 定义 BehaviorContext 及其关键字段 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { ActionTypeSchema, JsonValueSchema } from './schema-primitives.js';
import { MAX_ROUTING_SCOPE_PLUGINS, MAX_TRUSTED_FACTS, MAX_TRUSTED_FACT_KEY_LENGTH, MAX_TRUSTED_FACT_STRING_LENGTH, TRUSTED_FACT_KEY_PATTERN } from './types-base.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** BehaviorContext 摘要文本的统一长度边界。 */
export const MAX_CONTEXT_SUMMARY_LENGTH = 1200;

/** 下一轮模型可观察的有限 Plugin/Action 范围。 */
export const RoutingScopeSchema = Type.Object({
  activePluginId: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  candidatePluginIds: Type.Array(Type.String({ minLength: 1, maxLength: 320 }), { maxItems: MAX_ROUTING_SCOPE_PLUGINS, uniqueItems: true }),
  actionTypes: Type.Array(ActionTypeSchema, { maxItems: 6, uniqueItems: true }),
  continuation: Type.Union([Type.Literal('none'), Type.Literal('reuse'), Type.Literal('replace')])
}, { additionalProperties: false });

/** BehaviorContext 的主语及其不可变来源。 */
export const SubjectReferenceSchema = Type.Object({
  // type 描述主语的领域类型。
  type: Type.String({ minLength: 1 }),
  // id 是恢复主语时使用的稳定标识。
  id: Type.String({ minLength: 1 }),
  // status 区分已解析和待解析主语。
  status: Type.Union([Type.Literal('resolved'), Type.Literal('unresolved')]),
  // source 保留引用的事实来源。
  source: Type.Union([
    // 原始用户输入解析出的引用。
    Type.Literal('input'),
    // 从已有 BehaviorContext 恢复的引用。
    Type.Literal('context'),
    // 从不可变事件投影的引用。
    Type.Literal('event'),
    // 由插件或外部系统解析的引用。
    Type.Literal('plugin')
  ]),
  // sourceEventId 指向解析结果的事实事件。
  sourceEventId: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** BehaviorContext 中带状态的槽位值。 */
export const SlotValueSchema = Type.Object({
  // value 是可重放的槽位数据。
  value: JsonValueSchema,
  // status 区分待补齐、已解析和已确认。
  status: Type.Union([
    // 尚未获得可用值。
    Type.Literal('unresolved'),
    // 已获得值但未确认。
    Type.Literal('resolved'),
    // 已绑定到确认范围。
    Type.Literal('confirmed')
  ]),
  // sourceEventId 记录槽位来源。
  sourceEventId: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** BehaviorContext 当前工作流位置。 */
export const BehaviorWorkflowSchema = Type.Object({
  // workflowId 绑定当前使用的编排定义。
  workflowId: Type.Optional(Type.String({ minLength: 1 })),
  // currentStep 是恢复执行的步骤边界。
  currentStep: Type.String({ minLength: 1 }),
  // status 区分运行、等待和终态。
  status: Type.Union([
    // 尚未开始执行。
    Type.Literal('pending'),
    // 当前正在执行。
    Type.Literal('running'),
    // 正等待输入、确认或外部结果。
    Type.Literal('waiting'),
    // 已成功收敛。
    Type.Literal('completed'),
    // 已失败并记录结果。
    Type.Literal('failed'),
    // 已被明确取消。
    Type.Literal('cancelled')
  ])
}, { additionalProperties: false });

/** BehaviorContext 当前等待的输入。 */
export const PendingInputSchema = Type.Object({
  // kind 标识主循环正在等待哪类输入。
  kind: Type.Union([
    // 等待补齐槽位。
    Type.Literal('slot'),
    // 等待用户选择候选。
    Type.Literal('selection'),
    // 等待高风险动作确认。
    Type.Literal('confirmation'),
    // 等待新的自然语言或结构化输入。
    Type.Literal('input')
  ]),
  // status 记录输入是否已收到。
  status: Type.Union([Type.Literal('required'), Type.Literal('received'), Type.Literal('none')]),
  // options 只保存有限的展示键和值，不包含可执行动作。
  options: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 60 }),
    label: Type.String({ minLength: 1, maxLength: 200 })
  }, { additionalProperties: false }), { maxItems: 12, uniqueItems: true }))
}, { additionalProperties: false });

/** BehaviorContext 的确认状态和绑定范围。 */
export const ConfirmationStateSchema = Type.Object({
  // state 是动作确认的唯一状态来源。
  state: Type.Union([
    // 当前动作无需确认。
    Type.Literal('not_required'),
    // 当前动作等待明确确认。
    Type.Literal('required'),
    // 当前确认已绑定到 scopeHash。
    Type.Literal('confirmed'),
    // 当前确认被用户或策略拒绝。
    Type.Literal('rejected')
  ]),
  // scopeHash 把确认绑定到具体动作和参数。
  scopeHash: Type.Optional(Type.String({ minLength: 1 })),
  // confirmedAt 保留确认发生时间。
  confirmedAt: Type.Optional(Type.String({ minLength: 1 }))
}, { additionalProperties: false });

/** 成功输出中可供后续模型读取的可信事实。 */
export const TrustedFactSchema = Type.Object({
  // value 只能来自已经通过输出契约的公开字段。
  value: Type.Union([Type.String({ maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }), Type.Number(), Type.Boolean(), Type.Null()]),
  // 只有 verified 才能进入模型上下文。
  status: Type.Literal('verified'),
  // sourceEventId 绑定不可变成功事件。
  sourceEventId: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }),
  // functionId 和 pluginId 绑定事实归属。
  functionId: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }),
  // pluginId 绑定具体实现版本。
  pluginId: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }),
  // field 绑定公开输出字段。
  field: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_KEY_LENGTH, pattern: TRUSTED_FACT_KEY_PATTERN })
}, { additionalProperties: false });

/** 已通过压缩契约校验、可随会话恢复的摘要。 */
export const ContextSummarySchema = Type.Object({
  // text 只承载已校验的辅助摘要，不授予执行权限。
  text: Type.String({ minLength: 1, maxLength: MAX_CONTEXT_SUMMARY_LENGTH }),
  // version 标识摘要解释方式。
  version: Type.String({ minLength: 1, maxLength: 100 }),
  // eventId 指向生成摘要的不可变压缩事件。
  eventId: Type.String({ minLength: 1, maxLength: 200 })
}, { additionalProperties: false });

/** 不可变事实投影出的当前 BehaviorContext。 */
export const BehaviorContextSchema = Type.Object({
  // BehaviorContext 版本决定投影和重放方式。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.behaviorContext),
  // subject 保留当前操作对象及来源。
  subject: SubjectReferenceSchema,
  // intent 是语义提取后的稳定意图。
  intent: Type.String({ minLength: 1 }),
  // action 保留动作名称和执行阶段。
  action: Type.Object({
    // name 是宿主可审计的动作标识。
    name: Type.String({ minLength: 1 }),
    // status 防止恢复时重复解释动作阶段。
    status: Type.Union([
      Type.Literal('proposed'),
      Type.Literal('resolved'),
      Type.Literal('executed'),
      Type.Literal('failed')
    ])
  }, { additionalProperties: false }),
  // route 保留 Function 和已固定 Plugin。
  route: Type.Object({
    // functionId 是不可越过的功能边界。
    functionId: Type.Optional(Type.String({ minLength: 1 })),
    // pluginId 是重试时固定的实现版本。
    pluginId: Type.Optional(Type.String({ minLength: 1 }))
  }, { additionalProperties: false }),
  // routingScope 限制下一轮意图识别的 Plugin 和动作范围。
  routingScope: Type.Optional(RoutingScopeSchema),
  // slots 记录已解析和待确认参数。
  slots: Type.Record(Type.String(), SlotValueSchema),
  // workflow 记录可恢复的状态机位置。
  workflow: BehaviorWorkflowSchema,
  // pending 记录当前等待的用户输入。
  pending: PendingInputSchema,
  // confirmation 记录确认范围和状态。
  confirmation: ConfirmationStateSchema,
  // facts 只保存成功输出中的有限、可追溯事实。
  facts: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_KEY_LENGTH, pattern: TRUSTED_FACT_KEY_PATTERN }), TrustedFactSchema, { maxProperties: MAX_TRUSTED_FACTS })),
  // summary 是已校验的辅助视图，不进入关键执行字段哈希。
  summary: Type.Optional(ContextSummarySchema),
  // 幂等键贯穿一次 Action 提交和重试。
  idempotencyKey: Type.String({ minLength: 1 }),
  // integrity 绑定关键字段哈希和最后事实事件。
  integrity: Type.Object({
    // criticalFieldHash 防止压缩改变可执行状态。
    criticalFieldHash: Type.String({ minLength: 1 }),
    // lastEventId 是投影的恢复边界。
    lastEventId: Type.String({ minLength: 1 })
  }, { additionalProperties: false })
}, { additionalProperties: false });
