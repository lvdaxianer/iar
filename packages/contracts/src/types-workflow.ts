/**
 * 定义模型可返回的非权威 Workflow 事件协议。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */

/** 用户在当前 Workflow 输入中表达的通用意图。 */
export type WorkflowUserIntent =
  | 'start_workflow'
  | 'select_function'
  | 'provide_parameter'
  | 'confirm'
  | 'cancel_workflow'
  | 'new_topic'
  | 'answer_context'
  | 'unknown';

/** 当前输入对 Workflow 产生的通用事件。 */
export type WorkflowEvent =
  | 'function_selected'
  | 'parameter_received'
  | 'parameter_invalid'
  | 'confirmation_accepted'
  | 'confirmation_rejected'
  | 'workflow_cancelled'
  | 'new_topic'
  | 'unknown';

/** semantic.extract 返回的非权威 Workflow 决策。 */
export type WorkflowDecision = {
  /** 协议版本只决定字段解释，不授予执行权限。 */
  schemaVersion: typeof import('./versions.js').SCHEMA_VERSIONS.workflowDecision;
  /** 用户意图只用于辅助 Runtime 识别当前输入。 */
  userIntent: WorkflowUserIntent;
  /** 事件是当前输入的事实分类，不等于可执行授权。 */
  event: WorkflowEvent;
};
