/**
 * 定义 EventLog 的事件名称和统一事件外壳。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { Type } from '@sinclair/typebox';
import { JsonValueSchema } from './schema-primitives.js';
import { ConversationTurnSchema } from './schema-context.js';
import { SCHEMA_VERSIONS } from './versions.js';

/** 有限事件名称集合，保证投影语义稳定。 */
export const EventNameSchema = Type.Union([
  // 会话生命周期和消息事件供异步持久化订阅使用。
  Type.Literal('message.received'),
  Type.Literal('message.sent'),
  Type.Literal('session.restored'),
  Type.Literal('context.updated'),
  // 插件生命周期事件用于注册表和审计。
  Type.Literal('plugin.discovered'),
  Type.Literal('plugin.validated'),
  Type.Literal('plugin.installed'),
  Type.Literal('plugin.enabled'),
  Type.Literal('plugin.disabled'),
  Type.Literal('plugin.draining'),
  Type.Literal('plugin.unloaded'),
  Type.Literal('plugin.rejected'),
  // 决策事件记录有限候选和结构化结果。
  Type.Literal('decision.created'),
  // 工作流事件记录状态机开始和转移。
  Type.Literal('workflow.started'),
  Type.Literal('workflow.transitioned'),
  // Action 事件记录副作用的完整结果链。
  Type.Literal('action.started'),
  Type.Literal('action.completed'),
  Type.Literal('action.failed'),
  // 澄清事件只更新待输入状态，不携带执行授权。
  Type.Literal('context.clarification.updated'),
  // 事实焦点事件只更新后续上下文指代，不携带执行授权。
  Type.Literal('context.fact.focused'),
  // 会话轮次完成事件只记录完整的用户输入和最终回复。
  Type.Literal('conversation.turn.completed'),
  // 上下文事件记录压缩成功或失败。
  Type.Literal('context.compacted'),
  Type.Literal('context.compaction_failed')
]);

/** 会话轮次完成事件的专用载荷 Schema。 */
export const ConversationTurnCompletedEventPayloadSchema = Type.Object({
  // turn 是已经完成并可恢复的完整会话轮次。
  turn: ConversationTurnSchema
}, { additionalProperties: false });

// 未声明的事件名称会被拒绝，防止投影器出现隐式分支。
// 事件集合是 EventName 类型的运行时对应物。

/** EventLog 的不可变事件外壳。 */
export const EventEnvelopeSchema = Type.Object({
  // 事件版本决定投影器如何解析载荷。
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.event),
  // eventId 是不可变事件的唯一标识。
  eventId: Type.String({ minLength: 1 }),
  // eventName 决定事件对应的投影动作。
  eventName: EventNameSchema,
  // occurredAt 保留事实发生时间。
  occurredAt: Type.String({ minLength: 1 }),
  // runId 关联一次可恢复运行。
  runId: Type.String({ minLength: 1 }),
  // correlationId 关联业务链路。
  correlationId: Type.String({ minLength: 1 }),
  // causationId 关联直接前置事实。
  causationId: Type.Optional(Type.String({ minLength: 1 })),
  // payload 只允许可重放 JSON 值。
  payload: JsonValueSchema
}, { additionalProperties: false });

// 顶层额外字段被拒绝，确保事件回放输入稳定。
