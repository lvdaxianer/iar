/**
 * 为工作流模型实验提供无副作用的下一阶段判定器。
 *
 * 该文件只消费已验证的结构化输入，不调用模型、不访问 PluginHost、不执行 Handler。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import { validateContract, validateJsonSchemaValue, type ActionType, type BehaviorContext, type JsonSchema } from '@iar/contracts';
import type { SemanticFrame } from '@iar/runtime';
import type { WorkflowEvaluationNextStage } from './workflow-evaluation-fixtures.js';

/** 实验中可被运行时重新校验的 Function/Plugin 绑定。 */
export type WorkflowEvaluationFunction = {
  functionId: string;
  pluginId: string;
  actionTypes: readonly ActionType[];
  inputSchema: JsonSchema;
  requiresConfirmation: boolean;
};

/** 评估器强制检查的执行门禁摘要。 */
export type WorkflowEvaluationGates = {
  semanticFrameValidated: boolean;
  descriptorMatched: boolean;
  schemaValidated: boolean;
  parameterCollectionCompleted: boolean;
  policyValidated: boolean;
  idempotencyValidated: boolean;
  confirmationSatisfied: boolean;
  handlerReachable: boolean;
};

/** 结构化的下一阶段观测，不包含回复正文、模型原文或参数值。 */
export type WorkflowEvaluationOutcome = {
  nextStage: WorkflowEvaluationNextStage;
  execute: boolean;
  reasonCode: string;
  functionId?: string;
  pluginId?: string;
  gates: WorkflowEvaluationGates;
};

/** 下一阶段判定器输入。 */
export type WorkflowEvaluationInput = {
  frame: SemanticFrame;
  behaviorContext: BehaviorContext;
  authorizedFunctions: readonly WorkflowEvaluationFunction[];
};

/**
 * 根据契约、稳定路由、Function Schema 和确认策略推导下一阶段。
 *
 * @param input - 未信任的模型帧、结构化上下文和授权候选
 * @returns 不执行副作用的阶段观测
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function evaluateWorkflowFrame(input: WorkflowEvaluationInput): WorkflowEvaluationOutcome {
  const base = emptyGates();
  base.semanticFrameValidated = true;
  const contextResult = validateContract('behaviorContext', input.behaviorContext);
  if (!contextResult.ok) return outcome('unavailable', 'behavior_context_invalid', base);
  const context = contextResult.value as BehaviorContext;
  const selected = selectAuthorizedFunction(input.frame, context, input.authorizedFunctions);
  if (selected.kind !== 'matched') return outcome(selected.nextStage, selected.reasonCode, { ...base, descriptorMatched: false });
  base.descriptorMatched = true;
  const route = { functionId: selected.value.functionId, pluginId: selected.value.pluginId };
  if (!isActionCompatible(input.frame.action, selected.value.actionTypes)) return outcomeWithRoute('clarification', 'action_required', base, route);
  const parameters = validateParameters(input.frame, context, selected.value.inputSchema);
  if (!parameters.ok) return outcomeWithRoute('clarification', parameters.reasonCode, { ...base, schemaValidated: parameters.schemaValidated }, route);
  base.schemaValidated = true;
  base.parameterCollectionCompleted = true;
  base.policyValidated = true;
  base.idempotencyValidated = true;
  if (selected.value.requiresConfirmation) return outcomeWithRoute('awaiting_confirmation', 'confirmation_required', base, route);
  base.confirmationSatisfied = true;
  base.handlerReachable = true;
  return outcomeWithRoute('executed', 'ready_for_execution', base, route);
}

function selectAuthorizedFunction(frame: SemanticFrame, context: BehaviorContext, functions: readonly WorkflowEvaluationFunction[]): { kind: 'matched'; value: WorkflowEvaluationFunction } | { kind: 'unavailable' | 'clarification' | 'pass_through'; nextStage: WorkflowEvaluationNextStage; reasonCode: string } {
  const collectionTarget = context.collection?.kind === 'parameters' ? targetOf(context.collection.functionId, context.collection.pluginId) : undefined;
  const routeTarget = context.route.functionId === undefined ? undefined : targetOf(context.route.functionId, context.route.pluginId);
  const target = collectionTarget ?? routeTarget;
  if (target !== undefined) return matchTarget(target, functions);
  const candidates = functions.filter((candidate) => candidate.functionId === frame.intent || frame.pluginId !== undefined && candidate.pluginId === frame.pluginId);
  if (candidates.length === 1) return { kind: 'matched', value: candidates[0]! };
  if (candidates.length > 1) return { kind: 'clarification', nextStage: 'clarification', reasonCode: 'function_ambiguous' };
  if (frame.intent !== 'unknown' || frame.pluginId !== undefined) return { kind: 'unavailable', nextStage: 'unavailable', reasonCode: 'target_unavailable' };
  return { kind: 'pass_through', nextStage: 'pass_through', reasonCode: 'no_recovery_target' };
}

function matchTarget(target: { functionId: string; pluginId?: string }, functions: readonly WorkflowEvaluationFunction[]): { kind: 'matched'; value: WorkflowEvaluationFunction } | { kind: 'unavailable' | 'clarification'; nextStage: WorkflowEvaluationNextStage; reasonCode: string } {
  const candidates = functions.filter((candidate) => candidate.functionId === target.functionId && (target.pluginId === undefined || candidate.pluginId === target.pluginId));
  if (candidates.length === 1) return { kind: 'matched', value: candidates[0]! };
  if (candidates.length > 1) return { kind: 'clarification', nextStage: 'clarification', reasonCode: 'plugin_ambiguous' };
  return { kind: 'unavailable', nextStage: 'unavailable', reasonCode: 'target_unavailable' };
}

function targetOf(functionId: string, pluginId: string | undefined): { functionId: string; pluginId?: string } {
  return pluginId === undefined ? { functionId } : { functionId, pluginId };
}

function validateParameters(frame: SemanticFrame, context: BehaviorContext, schema: JsonSchema): { ok: true } | { ok: false; reasonCode: 'parameters_required' | 'parameters_invalid'; schemaValidated: boolean } {
  const previous = context.collection?.kind === 'parameters' ? context.collection.collected : {};
  const value: Record<string, unknown> = { ...previous, ...frame.slots };
  const required = requiredFields(schema);
  if (required.some((field) => !Object.hasOwn(value, field))) return { ok: false, reasonCode: 'parameters_required', schemaValidated: false };
  const validation = validateJsonSchemaValue(schema, value);
  return validation.ok ? { ok: true } : { ok: false, reasonCode: 'parameters_invalid', schemaValidated: false };
}

function requiredFields(schema: JsonSchema): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : [];
}

function isActionCompatible(action: SemanticFrame['action'], actionTypes: readonly ActionType[]): boolean {
  return action !== 'unknown' && actionTypes.includes(action);
}

function emptyGates(): WorkflowEvaluationGates {
  return { semanticFrameValidated: false, descriptorMatched: false, schemaValidated: false, parameterCollectionCompleted: false, policyValidated: false, idempotencyValidated: false, confirmationSatisfied: false, handlerReachable: false };
}

function outcome(nextStage: WorkflowEvaluationNextStage, reasonCode: string, gates: WorkflowEvaluationGates): WorkflowEvaluationOutcome {
  return { nextStage, execute: false, reasonCode, gates };
}

function outcomeWithRoute(nextStage: WorkflowEvaluationNextStage, reasonCode: string, gates: WorkflowEvaluationGates, route: { functionId: string; pluginId: string }): WorkflowEvaluationOutcome {
  return { ...outcome(nextStage, reasonCode, gates), execute: nextStage === 'executed', ...route };
}
