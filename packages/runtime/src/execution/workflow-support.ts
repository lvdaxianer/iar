/**
 * 提供 LocalWorkflow 的运行时输入、状态和结果辅助函数。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type ActionDefinition, type WorkflowDefinition } from '@iar/contracts';
import type { ConfirmationRequest, FailureRequest, WorkflowRequest, WorkflowResult, WorkflowRun } from './types.js';

/**
 * 校验 WorkflowDefinition 的公共 Schema 和本地状态关系。
 * @param request - 未信任的启动请求
 * @returns 是否可以创建本地状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validDefinition(request: unknown): request is WorkflowRequest {
  if (!isRecord(request) || typeof request.runId !== 'string' || request.runId.length === 0 || !isRecord(request.definition)) return false;
  const definition = request.definition as WorkflowDefinition;
  const validation = validateContract('workflow', definition);
  if (!validation.ok) return false;
  const states = new Set(definition.states);
  const transitionKeys = new Set<string>();
  const validTransitions = definition.transitions.every((item) => {
    // 同一 from/event 只能有一个确定性目标，拒绝隐式 find 选择。
    const key = `${item.from}:${item.event}`;
    if (transitionKeys.has(key)) return false;
    transitionKeys.add(key);
    return states.has(item.from) && states.has(item.to);
  });
  return states.has(definition.initialState)
    && !definition.terminalStates.includes(definition.initialState)
    && definition.terminalStates.every((state) => states.has(state))
    && validTransitions;
}

/**
 * 读取启动时绑定的 WorkflowDefinition。
 * @param run - 内存中的工作流记录
 * @returns 状态机定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function workflowDefinition(run: WorkflowRun): WorkflowDefinition {
  return run.definition;
}

/**
 * 校验 ActionDefinition 的公共 Schema。
 * @param value - 未信任的 Action
 * @returns 是否可进入 confirmation/hash/ledger 边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validAction(value: unknown): value is ActionDefinition {
  return validateContract('action', value).ok;
}

/**
 * 校验状态转移输入。
 * @param value - 未信任的 transition 请求
 * @returns 是否具备稳定 runId/event
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validTransitionInput(value: unknown): value is { runId: string; event: string } {
  return isRecord(value) && validRunId(value.runId) && typeof value.event === 'string' && value.event.length > 0;
}

/**
 * 校验 confirmation 请求的外围字段。
 * @param value - 未信任的 confirmation 请求
 * @returns 是否可继续校验 Action 和 scope
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validConfirmationInput(value: unknown): value is ConfirmationRequest {
  return isRecord(value) && validRunId(value.runId) && isRecord(value.action) && typeof value.scopeHash === 'string' && value.scopeHash.length > 0 && typeof value.confirmedAt === 'string' && value.confirmedAt.length > 0;
}

/**
 * 校验失败请求的错误码和 retryable 类型。
 * @param value - 未信任的失败请求
 * @returns 是否可写入 Workflow 错误状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validFailureInput(value: unknown): value is FailureRequest {
  return isRecord(value) && validRunId(value.runId) && typeof value.errorCode === 'string' && value.errorCode.length > 0 && typeof value.retryable === 'boolean';
}

/**
 * 校验稳定 runId。
 * @param value - 未信任的 runId
 * @returns 是否为非空字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 判断输入是否为普通对象。
 * @param value - 待判断值
 * @returns 是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断 WorkflowStatus 是否为不可恢复终态。
 * @param status - 当前运行态
 * @returns 是否已结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isTerminal(status: WorkflowRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * 构造稳定失败结果。
 * @param reasonCode - 稳定拒绝原因
 * @returns 显式失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function failure<T>(reasonCode: string): WorkflowResult<T> {
  return { ok: false, reasonCode };
}

/**
 * 构造成功结果。
 * @param value - 返回值
 * @returns 显式成功结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function success<T>(value: T): WorkflowResult<T> {
  return { ok: true, value };
}
