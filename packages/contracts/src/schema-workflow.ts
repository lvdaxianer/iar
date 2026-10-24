/**
 * 定义非权威 Workflow decision 的公共 Schema。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import { Type } from '@sinclair/typebox';
import { SCHEMA_VERSIONS } from './versions.js';

/** semantic.extract 可返回的用户意图枚举。 */
export const WorkflowUserIntentSchema = Type.Union([
  Type.Literal('start_workflow'),
  Type.Literal('select_function'),
  Type.Literal('provide_parameter'),
  Type.Literal('confirm'),
  Type.Literal('cancel_workflow'),
  Type.Literal('new_topic'),
  Type.Literal('answer_context'),
  Type.Literal('unknown')
]);

/** semantic.extract 可返回的 Workflow 事件枚举。 */
export const WorkflowEventSchema = Type.Union([
  Type.Literal('function_selected'),
  Type.Literal('parameter_received'),
  Type.Literal('parameter_invalid'),
  Type.Literal('confirmation_accepted'),
  Type.Literal('confirmation_rejected'),
  Type.Literal('workflow_cancelled'),
  Type.Literal('new_topic'),
  Type.Literal('context_answered'),
  Type.Literal('unknown')
]);

/** 版本化且不含执行标识的 Workflow decision。 */
export const WorkflowDecisionSchema = Type.Object({
  schemaVersion: Type.Literal(SCHEMA_VERSIONS.workflowDecision),
  userIntent: WorkflowUserIntentSchema,
  event: WorkflowEventSchema
}, { additionalProperties: false });
