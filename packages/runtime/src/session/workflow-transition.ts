/**
 * 提供通用 Workflow 事件到状态的确定性转换。
 *
 * 该模块只接受已通过 contracts 校验的 WorkflowDecision，不解析业务标识，
 * 也不执行任何 Function。真正的执行授权仍由路由、Schema、权限、策略、
 * 幂等和确认门禁共同决定。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import type { WorkflowDecision, WorkflowEvent } from '@iar/contracts';

/** Runtime 派生的通用 Workflow 状态。 */
export type WorkflowPhase =
  | 'normal'
  | 'function_selection'
  | 'collecting_parameters'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** 当前仍可推进的 Workflow 阶段。终态只作为历史结果展示。 */
export type WorkflowActivePhase = Exclude<WorkflowPhase, 'completed' | 'cancelled' | 'failed'>;

/** 已结束的 Workflow 结果。 */
export type WorkflowOutcome = Extract<WorkflowPhase, 'completed' | 'cancelled' | 'failed'>;

/** 状态转换成功或被安全拒绝的结果。 */
export type WorkflowTransitionResult =
  | { ok: true; currentState: WorkflowPhase; nextState: WorkflowPhase; event: WorkflowEvent }
  | { ok: false; reasonCode: 'workflow_transition_invalid'; currentState: WorkflowPhase; event: WorkflowEvent };

/** Runtime 对模型事件的安全处置结果，不携带模型提出的目标或下一状态。 */
export type WorkflowDecisionDisposition =
  | { kind: 'none' }
  | { kind: 'accepted'; event: WorkflowEvent }
  | { kind: 'cancelled'; event: Extract<WorkflowEvent, 'workflow_cancelled' | 'new_topic'> }
  | { kind: 'invalid'; reasonCode: 'workflow_transition_invalid'; event: WorkflowEvent };

/** 有界的事件转换表；未声明的事件默认拒绝。 */
const TRANSITIONS: Readonly<Record<WorkflowPhase, Partial<Record<WorkflowEvent, WorkflowPhase>>>> = {
  normal: {
    function_selected: 'function_selection',
    parameter_received: 'collecting_parameters',
    new_topic: 'normal',
    workflow_cancelled: 'cancelled'
  },
  function_selection: {
    function_selected: 'function_selection',
    parameter_received: 'collecting_parameters',
    workflow_cancelled: 'cancelled',
    new_topic: 'normal'
  },
  collecting_parameters: {
    parameter_received: 'collecting_parameters',
    parameter_invalid: 'collecting_parameters',
    workflow_cancelled: 'cancelled',
    new_topic: 'normal'
  },
  awaiting_confirmation: {
    confirmation_accepted: 'executing',
    confirmation_rejected: 'collecting_parameters',
    workflow_cancelled: 'cancelled',
    new_topic: 'normal'
  },
  executing: {},
  completed: {
    function_selected: 'function_selection',
    parameter_received: 'collecting_parameters',
    new_topic: 'normal'
  },
  cancelled: {
    function_selected: 'function_selection',
    parameter_received: 'collecting_parameters',
    new_topic: 'normal'
  },
  failed: {
    function_selected: 'function_selection',
    parameter_received: 'collecting_parameters',
    new_topic: 'normal'
  }
};

/**
 * 按有限转换表计算下一状态。
 *
 * @param currentState - Runtime 根据 BehaviorContext 派生的当前状态
 * @param decision - 已通过 WorkflowDecision Schema 的非权威事件
 * @returns 确定性转换结果，不执行副作用
 */
export function transitionWorkflow(currentState: WorkflowPhase, decision: WorkflowDecision): WorkflowTransitionResult {
  const event = decision.event;
  if (event === 'context_answered') return { ok: true, currentState, nextState: currentState, event };
  if (isWorkflowOutcome(currentState) && event !== 'unknown') return { ok: true, currentState, nextState: 'normal', event };
  const transitions = Object.hasOwn(TRANSITIONS, currentState) ? TRANSITIONS[currentState] : undefined;
  if (!transitions) return { ok: false, reasonCode: 'workflow_transition_invalid', currentState, event };
  const nextState = transitions[event];
  if (!nextState) return { ok: false, reasonCode: 'workflow_transition_invalid', currentState, event };
  return { ok: true, currentState, nextState, event };
}

/**
 * 返回当前状态可观察的有限事件集合。
 *
 * `unknown` 是允许的分类结果，但不对应状态转换，避免模型被迫猜测。
 *
 * @param currentState - Runtime 派生的当前状态
 * @returns 有序且去重的允许事件
 */
export function allowedWorkflowEvents(currentState: WorkflowPhase): WorkflowEvent[] {
  if (isWorkflowOutcome(currentState)) return ['unknown', 'context_answered', 'function_selected', 'parameter_received', 'parameter_invalid', 'confirmation_accepted', 'confirmation_rejected', 'workflow_cancelled', 'new_topic'];
  const transitions = Object.hasOwn(TRANSITIONS, currentState) ? TRANSITIONS[currentState] : undefined;
  if (!transitions) return ['unknown'];
  return ['unknown', 'context_answered', ...Object.keys(transitions) as WorkflowEvent[]];
}

/** 校验模型事件并归一化取消/换题分支，执行授权仍由会话编排层负责。 */
export function classifyWorkflowDecision(currentState: WorkflowPhase, decision: WorkflowDecision | undefined): WorkflowDecisionDisposition {
  if (decision === undefined) return { kind: 'none' };
  if (decision.event === 'context_answered' || decision.event === 'unknown') return { kind: 'none' };
  const transition = transitionWorkflow(currentState, decision);
  if (!transition.ok) return { kind: 'invalid', reasonCode: transition.reasonCode, event: decision.event };
  if (decision.event === 'workflow_cancelled' || decision.event === 'new_topic') return { kind: 'cancelled', event: decision.event };
  return { kind: 'accepted', event: decision.event };
}

/** 判断状态是否已经结束；终态不再作为下一轮输入的活动门禁。 */
function isWorkflowOutcome(state: WorkflowPhase): state is WorkflowOutcome {
  return state === 'completed' || state === 'cancelled' || state === 'failed';
}
