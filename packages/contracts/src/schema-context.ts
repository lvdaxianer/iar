/**
 * 定义 BehaviorContext 及其关键字段 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { ActionTypeSchema, JsonValueSchema } from './schema-primitives.js';
import { MAX_FACT_RECORD_ID_LENGTH, MAX_FACT_RECORD_VALUES, MAX_FACT_SEQUENCE, MAX_ROUTING_SCOPE_PLUGINS, MAX_TRUSTED_FACTS, MAX_TRUSTED_FACT_KEY_LENGTH, MAX_TRUSTED_FACT_STRING_LENGTH, TRUSTED_FACT_KEY_PATTERN } from './types-base.js';
import {
  MAX_CANDIDATE_KEY_LENGTH,
  MAX_CANDIDATE_VERSION_LENGTH,
  MAX_COLLECTION_ATTEMPTS,
  MAX_COLLECTION_CANDIDATES,
  MAX_COLLECTION_FIELD_LENGTH,
  MAX_COLLECTION_FIELDS,
  MAX_CLARIFICATION_LABEL_LENGTH,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_REASON_LENGTH,
  MAX_CONVERSATION_TURN_ID_LENGTH,
  MAX_CONVERSATION_TURNS,
  MAX_CONVERSATION_TURN_SEQUENCE,
  MAX_CONVERSATION_TURN_TEXT_LENGTH,
  MAX_PENDING_REFERENCE_CANDIDATES,
  MAX_PENDING_REFERENCE_OFFSET,
  MAX_PENDING_REFERENCE_TEXT_LENGTH,
  MAX_RECENT_MESSAGE_CHARS,
  MAX_RECENT_MESSAGE_LIMIT,
  MAX_UNRESOLVED_STREAK
} from './types-state.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** BehaviorContext 摘要文本的统一长度边界。 */
export const MAX_CONTEXT_SUMMARY_LENGTH = 1200;

/** 收集器独立使用的递归 JSON 值 Schema，避免与槽位递归引用共享 $id。 */
const CollectionJsonValueSchema = Type.Recursive((self) => Type.Union([
  Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(self), Type.Record(Type.String(), self)
]), { $id: 'https://iar.dev/schema/collection-json-value/v1' });

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
    key: Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_KEY_LENGTH }),
    label: Type.String({ minLength: 1, maxLength: MAX_CLARIFICATION_LABEL_LENGTH })
  }, { additionalProperties: false }), { maxItems: MAX_CLARIFICATION_OPTIONS, uniqueItems: true }))
}, { additionalProperties: false });

/** 最近消息窗口策略 Schema，只保存边界而不保存原文。 */
export const RecentMessagePolicySchema = Type.Object({
  // recentMessageLimit 限制模型可观察的历史消息数量。
  recentMessageLimit: Type.Integer({ minimum: 1, maximum: MAX_RECENT_MESSAGE_LIMIT }),
  // maxMessageChars 限制单条历史消息进入模型前的长度。
  maxMessageChars: Type.Integer({ minimum: 1, maximum: MAX_RECENT_MESSAGE_CHARS })
}, { additionalProperties: false });

/** 连续未解决和动态候选选择的持久化状态 Schema。 */
export const ClarificationStateSchema = Type.Object({
  // mode 只表示澄清生命周期，不授予任何执行权限。
  mode: Type.Union([
    Type.Literal('none'),
    Type.Literal('unresolved'),
    Type.Literal('selection')
  ]),
  // unresolvedStreak 受界限保护，避免异常状态无限增长。
  unresolvedStreak: Type.Integer({ minimum: 0, maximum: MAX_UNRESOLVED_STREAK }),
  // reasonCode 记录稳定原因，不保存模型自由文本。
  reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CLARIFICATION_REASON_LENGTH })),
  // candidateVersion 用于检测候选注册表变更。
  candidateVersion: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_VERSION_LENGTH })),
  // candidateKeys 是当前候选集合中的不透明键。
  candidateKeys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_KEY_LENGTH }), { maxItems: MAX_CLARIFICATION_OPTIONS, uniqueItems: true }))
}, { additionalProperties: false });

/** Function/参数收集器的可恢复状态 Schema，不授予执行权限。 */
export const CollectionStateSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('function'),
    pluginId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH })),
    candidateFunctionIds: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), { minItems: 1, maxItems: MAX_COLLECTION_CANDIDATES, uniqueItems: true }),
    candidateKeys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX_CANDIDATE_KEY_LENGTH }), { maxItems: MAX_COLLECTION_CANDIDATES, uniqueItems: true })),
    reasonCode: Type.Union([Type.Literal('function_missing'), Type.Literal('function_ambiguous')]),
    attempt: Type.Integer({ minimum: 1, maximum: MAX_COLLECTION_ATTEMPTS })
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('parameters'),
    functionId: Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }),
    pluginId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH })),
    schemaVersion: Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }),
    collected: Type.Record(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), CollectionJsonValueSchema, { maxProperties: MAX_COLLECTION_FIELDS }),
    missingFields: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), { maxItems: MAX_COLLECTION_FIELDS, uniqueItems: true }),
    invalidFields: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), { maxItems: MAX_COLLECTION_FIELDS, uniqueItems: true }),
    conflictFields: Type.Array(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), { maxItems: MAX_COLLECTION_FIELDS, uniqueItems: true }),
    attempt: Type.Integer({ minimum: 1, maximum: MAX_COLLECTION_ATTEMPTS }),
    presentation: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), Type.Object({
      label: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CLARIFICATION_LABEL_LENGTH })),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CLARIFICATION_LABEL_LENGTH })),
      control: Type.Optional(Type.Union([
        Type.Literal('text'), Type.Literal('number'), Type.Literal('boolean'), Type.Literal('select'), Type.Literal('multi-select'), Type.Literal('object')
      ])),
      options: Type.Optional(Type.Array(Type.Object({ value: Type.String({ minLength: 1, maxLength: MAX_COLLECTION_FIELD_LENGTH }), label: Type.String({ minLength: 1, maxLength: MAX_CLARIFICATION_LABEL_LENGTH }) }, { additionalProperties: false }), { maxItems: MAX_CLARIFICATION_OPTIONS, uniqueItems: true }))
    }, { additionalProperties: false }), { maxProperties: MAX_COLLECTION_FIELDS }))
  }, { additionalProperties: false })
]);

/** 待解析事实引用 Schema，只保存通用关系和不透明记录 ID。 */
export const PendingReferenceSchema = Type.Object({
  // text 仅用于模型理解当前待澄清指代，不授予执行权限。
  text: Type.String({ minLength: 1, maxLength: MAX_PENDING_REFERENCE_TEXT_LENGTH }),
  // relation 是有限的事实链相对关系。
  relation: Type.Union([
    Type.Literal('current'), Type.Literal('previous'), Type.Literal('next'),
    Type.Literal('first'), Type.Literal('last'), Type.Literal('offset')
  ]),
  // anchorRecordId 必须是不透明事实记录 ID。
  anchorRecordId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH })),
  // offset 只允许在运行时关系边界内移动。
  offset: Type.Optional(Type.Integer({ minimum: -MAX_PENDING_REFERENCE_OFFSET, maximum: MAX_PENDING_REFERENCE_OFFSET })),
  // 候选数量有界且记录 ID 不重复。
  candidateRecordIds: Type.Array(Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH }), { minItems: 1, maxItems: MAX_PENDING_REFERENCE_CANDIDATES, uniqueItems: true })
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

/** 单条有序可信事实记录 Schema。 */
export const VerifiedFactRecordSchema = Type.Object({
  // recordId 是运行时生成的不透明稳定标识。
  recordId: Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH }),
  // sequence 决定历史关系的顺序解析。
  sequence: Type.Integer({ minimum: 1, maximum: MAX_FACT_SEQUENCE }),
  // sourceEventId 绑定不可变成功事件。
  sourceEventId: Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH }),
  // functionId 只作为动态能力标识保存。
  functionId: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }),
  // pluginId 只作为动态实现标识保存。
  pluginId: Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }),
  // values 只允许 Plugin 显式声明的有限原子值。
  values: Type.Record(Type.String({ minLength: 1, maxLength: MAX_TRUSTED_FACT_KEY_LENGTH, pattern: TRUSTED_FACT_KEY_PATTERN }), Type.Union([Type.String({ maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }), Type.Number(), Type.Boolean(), Type.Null()]), { maxProperties: MAX_FACT_RECORD_VALUES }),
  // createdAt 保留来源事件发生时间。
  createdAt: Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH })
}, { additionalProperties: false });

/** 有序可信事实历史 Schema。 */
export const VerifiedFactHistorySchema = Type.Object({
  // records 按 sequence 升序保存且数量有界。
  records: Type.Array(VerifiedFactRecordSchema, { maxItems: MAX_TRUSTED_FACTS }),
  // focusRecordId 只允许指向当前历史中的不透明记录。
  focusRecordId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_FACT_RECORD_ID_LENGTH }))
}, { additionalProperties: false });

/** 单条有序会话轮次 Schema。 */
export const ConversationTurnSchema = Type.Object({
  // turnId 是不透明的稳定轮次标识。
  turnId: Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TURN_ID_LENGTH }),
  // sequence 决定会话轮次的唯一顺序。
  sequence: Type.Integer({ minimum: 1, maximum: MAX_CONVERSATION_TURN_SEQUENCE }),
  // userText 只保存有界的用户输入原文。
  userText: Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TURN_TEXT_LENGTH }),
  // assistantText 只保存完整提交的最终回复。
  assistantText: Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TURN_TEXT_LENGTH }),
  // outcome 是回复完成时的稳定结果状态。
  outcome: Type.Union([
    Type.Literal('completed'),
    Type.Literal('awaiting_confirmation'),
    Type.Literal('needs_clarification'),
    Type.Literal('failed'),
    Type.Literal('cancelled')
  ]),
  // actionTaken 只是结果元数据，不授予后续执行权限。
  actionTaken: Type.Boolean(),
  // completedAt 标识轮次完成事件的发生时间。
  completedAt: Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TURN_ID_LENGTH })
}, { additionalProperties: false });

/** 有序会话轮次历史 Schema。 */
export const ConversationTurnHistorySchema = Type.Object({
  // turns 按 sequence 升序保存且数量有界。
  turns: Type.Array(ConversationTurnSchema, { maxItems: MAX_CONVERSATION_TURNS }),
  // focusTurnId 只允许指向当前历史中的轮次。
  focusTurnId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TURN_ID_LENGTH }))
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
  // recentMessagePolicy 只保存消息窗口策略，不复制原始消息。
  recentMessagePolicy: Type.Optional(RecentMessagePolicySchema),
  // clarification 保存可恢复的通用澄清状态。
  clarification: Type.Optional(ClarificationStateSchema),
  // collection 保存 Function/参数收集的有限状态，不代表授权。
  collection: Type.Optional(CollectionStateSchema),
  // pendingReference 保存通用事实关系的有限消歧状态。
  pendingReference: Type.Optional(PendingReferenceSchema),
  // confirmation 记录确认范围和状态。
  confirmation: ConfirmationStateSchema,
  // factHistory 保存成功输出中的有限、可追溯有序事实。
  factHistory: Type.Optional(VerifiedFactHistorySchema),
  // conversationTurns 保存用户输入与最终回复的有序轮次。
  conversationTurns: Type.Optional(ConversationTurnHistorySchema),
  // facts 仅用于旧快照兼容读取，新投影不再写入。
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
