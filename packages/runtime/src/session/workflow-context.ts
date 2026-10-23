/**
 * 将已验证 BehaviorContext 投影为 semantic.extract 可观察的 Workflow context。
 *
 * 该投影只提供状态、允许事件、已验证目标和字段状态；不复制参数值、确认
 * scope、凭据或原始模型数据，也不产生任何执行授权。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import type { BehaviorContext, CollectionState, WorkflowEvent } from '@iar/contracts';
import { allowedWorkflowEvents, type WorkflowPhase } from './workflow-transition.js';

/** Workflow context 投影版本。 */
export const WORKFLOW_CONTEXT_MAP_VERSION = 'iar.workflow-map/v1' as const;

/** 投影中的已验证路由摘要。 */
export type WorkflowRouteProjection = {
  functionId?: string;
  pluginId?: string;
};

/** 投影中的参数收集摘要，不含参数值。 */
export type WorkflowCollectionProjection =
  | {
      kind: 'function';
      pluginId?: string;
      candidateFunctionCount: number;
      candidateKeys?: string[];
    }
  | {
      kind: 'parameters';
      functionId: string;
      pluginId?: string;
      schemaVersion: string;
      collectedFields: string[];
      missingFields: string[];
      invalidFields: string[];
      conflictFields: string[];
      presentationFields: string[];
    };

/** 提供给模型和诊断层的有界 Workflow context。 */
export type WorkflowContextProjection = {
  mapVersion: typeof WORKFLOW_CONTEXT_MAP_VERSION;
  currentState: WorkflowPhase;
  workflowStatus: BehaviorContext['workflow']['status'];
  allowedEvents: WorkflowEvent[];
  pending: { kind: BehaviorContext['pending']['kind']; status: BehaviorContext['pending']['status'] };
  confirmation: { state: BehaviorContext['confirmation']['state'] };
  route?: WorkflowRouteProjection;
  collection?: WorkflowCollectionProjection;
};

/**
 * 从 BehaviorContext 生成有界 Workflow context。
 *
 * @param context - 已通过 BehaviorContext 契约和完整性校验的状态
 * @returns 不含参数值和确认凭据的模型上下文投影
 */
export function projectWorkflowContext(context: BehaviorContext): WorkflowContextProjection {
  const currentState = deriveWorkflowPhase(context);
  const route = projectRoute(context);
  const collection = projectCollection(context.collection);
  return {
    mapVersion: WORKFLOW_CONTEXT_MAP_VERSION,
    currentState,
    workflowStatus: context.workflow.status,
    allowedEvents: allowedWorkflowEvents(currentState),
    pending: { kind: context.pending.kind, status: context.pending.status },
    confirmation: { state: context.confirmation.state },
    ...(route ? { route } : {}),
    ...(collection ? { collection } : {})
  };
}

/** 根据已验证状态字段派生通用 Workflow phase。 */
function deriveWorkflowPhase(context: BehaviorContext): WorkflowPhase {
  if (context.workflow.status === 'completed') return 'completed';
  if (context.workflow.status === 'cancelled') return 'cancelled';
  if (context.workflow.status === 'failed') return 'failed';
  if (context.confirmation.state === 'required' || context.pending.kind === 'confirmation') return 'awaiting_confirmation';
  if (context.confirmation.state === 'confirmed' && context.pending.status === 'none') return 'completed';
  if (context.collection?.kind === 'parameters' || context.pending.kind === 'slot') return 'collecting_parameters';
  if (context.collection?.kind === 'function' || context.pending.kind === 'selection') return 'function_selection';
  const stepPhase = knownStepPhase(context.workflow.currentStep);
  if (stepPhase) return stepPhase;
  if (context.workflow.status === 'running' || context.action.status === 'resolved') return 'executing';
  return 'normal';
}

/** 只识别通用状态名称，未知 currentStep 不改变安全默认值。 */
function knownStepPhase(step: string): WorkflowPhase | undefined {
  const phases: readonly WorkflowPhase[] = ['normal', 'function_selection', 'collecting_parameters', 'awaiting_confirmation', 'executing', 'completed', 'cancelled', 'failed'];
  return phases.includes(step as WorkflowPhase) ? step as WorkflowPhase : undefined;
}

/** 投影已验证路由，只保留存在的动态标识。 */
function projectRoute(context: BehaviorContext): WorkflowRouteProjection | undefined {
  const { functionId, pluginId } = context.route;
  return functionId || pluginId ? { ...(functionId ? { functionId } : {}), ...(pluginId ? { pluginId } : {}) } : undefined;
}

/** 投影收集状态，只保留字段状态和有限候选摘要。 */
function projectCollection(collection: CollectionState | undefined): WorkflowCollectionProjection | undefined {
  if (!collection) return undefined;
  if (collection.kind === 'function') {
    return {
      kind: 'function',
      ...(collection.pluginId ? { pluginId: collection.pluginId } : {}),
      candidateFunctionCount: collection.candidateFunctionIds.length,
      ...(collection.candidateKeys ? { candidateKeys: [...collection.candidateKeys] } : {})
    };
  }
  return {
    kind: 'parameters',
    functionId: collection.functionId,
    ...(collection.pluginId ? { pluginId: collection.pluginId } : {}),
    schemaVersion: collection.schemaVersion,
    collectedFields: Object.keys(collection.collected),
    missingFields: [...collection.missingFields],
    invalidFields: [...collection.invalidFields],
    conflictFields: [...collection.conflictFields],
    presentationFields: collection.presentation ? Object.keys(collection.presentation) : []
  };
}
