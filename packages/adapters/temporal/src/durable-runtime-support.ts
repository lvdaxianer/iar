/**
 * 提供 durable runtime 的恢复、脱敏和结果辅助函数。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type ActionResult, type EventEnvelope } from '@iar/contracts';
import { LocalWorkflow, confirmationScopeHash, type ExecuteRequest, type WorkflowRequest, type WorkflowResult, type WorkflowRun } from '@iar/runtime';
import type { DurableActionRecord, DurableExecuteRequest, DurableStepOperation, DurableWorkflowSnapshot } from './types.js';
import { failedAction, redactPayload } from './durable-runtime-redaction.js';

export type LoadedRun = { snapshot: DurableWorkflowSnapshot; local: LocalWorkflow };

/**
 * 创建一个空的持久快照。
 * @param run - 初始运行态
 * @returns durable 快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createSnapshot(run: WorkflowRun): DurableWorkflowSnapshot {
  return { version: 1, run: structuredClone(run), steps: [{ stepId: 'workflow-start', sequence: 1, operation: 'start', status: 'completed', data: { kind: 'start' } }], actions: [], events: [], nextEventSequence: 1 };
}

/**
 * 按 sequence 重放持久步骤，恢复 LocalWorkflow 状态。
 * @param local - 新建的本地状态机
 * @param snapshot - 持久化快照
 * @returns 无返回值
 * @throws Error 当 start 或 step 重放不成功
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function replaySnapshot(local: LocalWorkflow, snapshot: DurableWorkflowSnapshot): Promise<void> {
  const started = local.start({ runId: snapshot.run.runId, definition: snapshot.run.definition });
  // start 失败说明快照的 WorkflowDefinition 或 run identity 已损坏。
  if (!started.ok) throw new Error('durable_snapshot_invalid');
  const steps = [...snapshot.steps].sort((left, right) => left.sequence - right.sequence);
  for (const step of steps) {
    const result = await replayStep(local, snapshot, step);
    // 任一步骤无法按原顺序重放时，整个快照都不能继续使用。
    if (result && !result.ok) throw new Error('durable_snapshot_invalid');
  }
  const current = local.get(snapshot.run.runId);
  // 重放后的关键状态必须与持久 run 一致，防止静默状态漂移。
  if (!current.ok || !sameRunState(current.value, snapshot.run)) throw new Error('durable_snapshot_invalid');
}

/**
 * 重放一个 completed step，pending Action 保持未收敛而不调用副作用。
 * @param local - 本地状态机
 * @param snapshot - 持久化快照
 * @param step - 待重放 step
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function replayStep(local: LocalWorkflow, snapshot: DurableWorkflowSnapshot, step: DurableWorkflowSnapshot['steps'][number]): Promise<WorkflowResult<WorkflowRun> | undefined> {
  // pending step 不代表副作用已完成，恢复时必须保持未收敛。
  if (step.status !== 'completed' || step.operation === 'start') return;
  const data = step.data;
  // transition 只重放公开状态转移，不重建外部副作用。
  if (data.kind === 'transition') return local.transition({ runId: snapshot.run.runId, event: data.event });
  // confirmation 使用脱敏 Action 重新计算 scope，保持确认语义。
  if (data.kind === 'confirm') {
    const safeInput = { ...data.input, scopeHash: confirmationScopeHash(data.input.action) };
    return local.confirm(safeInput);
  }
  // execute 只能使用已经持久化的结果重放，不能调用未知 executor。
  if (data.kind === 'execute') {
    const replayed = await replayAction(local, snapshot, step);
    if (!replayed || !replayed.ok) return failure('durable_snapshot_invalid');
    return local.get(snapshot.run.runId);
  }
  // 失败、重试、超时、取消和恢复沿用 LocalWorkflow 的确定性语义。
  if (data.kind === 'fail') return local.fail(data.input);
  if (data.kind === 'retry') return local.retry(data.runId);
  if (data.kind === 'timeout') return local.timeout(data.runId);
  if (data.kind === 'cancel') return local.cancel(data.runId);
  if (data.kind === 'resume') return local.resume(data.runId);
  return undefined;
}

/**
 * 用持久 ActionResult 进行无副作用的本地状态重放。
 * @param local - 本地状态机
 * @param snapshot - 持久快照
 * @param step - execute step
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function replayAction(local: LocalWorkflow, snapshot: DurableWorkflowSnapshot, step: DurableWorkflowSnapshot['steps'][number]): Promise<WorkflowResult<ActionResult> | undefined> {
  // 非 execute step 没有可重放的 Action 记录。
  if (step.data.kind !== 'execute') return undefined;
  const record = findAction(snapshot.actions, step.data.request.action.idempotencyKey);
  // 缺少 completed outcome 时不能猜测未知副作用的结果。
  if (!record?.outcome) return undefined;
  const result = record.outcome.ok ? record.outcome.value : failedAction(record.request.action, record.outcome.reasonCode);
  return local.execute({ ...record.request, executor: () => result } as ExecuteRequest);
}

/**
 * 用当前调用方 Action 修复脱敏恢复后的 confirmation scope。
 * @param loaded - 已恢复的 Workflow
 * @param input - 当前真实 Action 请求
 * @returns confirmation 结果或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function repairLocalConfirmation(loaded: LoadedRun, input: DurableExecuteRequest): WorkflowResult<WorkflowRun> | undefined {
  // 非确认 Action 不需要修复 confirmation scope。
  if (loaded.snapshot.run.confirmation.state !== 'confirmed') return undefined;
  const confirmedAt = loaded.snapshot.run.confirmation.confirmedAt;
  // confirmed 状态没有时间戳时视为损坏快照。
  if (!confirmedAt) return failure('confirmation_scope_mismatch');
  return loaded.local.confirm({ runId: input.runId, action: input.action, scopeHash: confirmationScopeHash(input.action), confirmedAt });
}

/**
 * 查找 Action 持久记录。
 * @param actions - 持久 Action 列表
 * @param idempotencyKey - 幂等键
 * @returns Action 记录或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function findAction(actions: readonly DurableActionRecord[], idempotencyKey: string): DurableActionRecord | undefined {
  return actions.find((record) => record.request.action.idempotencyKey === idempotencyKey);
}

/**
 * 处理已存在的 Action 结果或 pending 状态。
 * @param existing - 已存在的 Action 记录
 * @param input - 当前请求
 * @returns 重放结果或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function replayExisting(existing: DurableActionRecord, input: DurableExecuteRequest): WorkflowResult<ActionResult> {
  // 相同幂等键必须绑定完整 Action 身份，避免重放错误输入。
  if (existing.actionDigest !== actionDigest(input.action)) return failure('idempotency_key_conflict');
  // pending 记录不能被当作成功结果返回。
  if (existing.status === 'pending' || !existing.outcome) return failure('durable_action_in_progress');
  return existing.outcome.ok ? { ...structuredClone(existing.outcome), reasonCode: 'action_duplicate' } : structuredClone(existing.outcome);
}

/**
 * 生成 durable event 的稳定外壳。
 * @param event - LocalWorkflow 事件
 * @param runId - Workflow 运行标识
 * @param adapterName - adapter 名称
 * @param sequence - durable 事件序号
 * @returns durable 事件副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function durableEvent(event: EventEnvelope, runId: string, adapterName: string, sequence: number): EventEnvelope {
  return { ...structuredClone(event), eventId: `durable-event-${adapterName}-${runId}-${sequence}`, correlationId: `${adapterName}:${runId}`, payload: redactPayload(event.payload) };
}

/**
 * 校验 Workflow 启动请求的外围字段和公共 Schema。
 * @param request - 未信任启动请求
 * @returns 是否为合法请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isWorkflowRequest(request: unknown): request is WorkflowRequest {
  try {
    // 外围字段不完整时，不进入公共 Workflow Schema 校验。
    return isRecord(request) && validRunId(request.runId) && isRecord(request.definition) && validateContract('workflow', request.definition).ok;
  } catch {
    return false;
  }
}

/**
 * 校验状态转移输入。
 * @param input - 未信任转移输入
 * @returns 是否为合法转移输入
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validTransitionInput(input: unknown): input is { runId: string; event: string } {
  return isRecord(input) && validRunId(input.runId) && typeof input.event === 'string' && input.event.length > 0;
}

/**
 * 校验 durable Action 请求和 executor 前置边界。
 * @param input - 未信任 Action 请求
 * @returns 是否为可持久化请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isDurableExecuteRequest(input: unknown): input is DurableExecuteRequest {
  try {
    return isRecord(input) && validRunId(input.runId) && validRunId(input.stepId) && isRecord(input.action) && input.action.runId === input.runId && validateContract('action', input.action).ok && Array.isArray(input.requiredCapabilities) && Array.isArray(input.grantedCapabilities) && typeof input.authorized === 'boolean' && (input.retryable === undefined || typeof input.retryable === 'boolean');
  } catch {
    // revoked Proxy、恶意 getter 或异常 Schema 输入统一按非法请求处理。
    return false;
  }
}

/**
 * 校验稳定 runId。
 * @param value - 未信任 runId
 * @returns 是否为非空字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 从未信任请求安全提取 runId。
 * @param input - 未信任请求
 * @returns 合法 runId 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function safeRunId(input: unknown): string | undefined {
  try {
    // 只有可安全读取的合法 runId 才能用于缓存清理。
    return isRecord(input) && validRunId(input.runId) ? input.runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 生成 Action 全量身份的稳定摘要。
 * @param action - Action 定义
 * @returns 不包含原始输入的身份摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function actionDigest(action: DurableExecuteRequest['action']): string {
  return confirmationScopeHash(action);
}

/**
 * 比较恢复所需的 Workflow 状态字段，忽略脱敏后的 Action input。
 * @param left - 本地恢复状态
 * @param right - 持久快照状态
 * @returns 状态是否一致
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function sameRunState(left: WorkflowRun, right: WorkflowRun): boolean {
  return JSON.stringify(comparableRun(left)) === JSON.stringify(comparableRun(right));
}

/**
 * 选取不受脱敏 Action input 影响的恢复字段。
 * @param run - Workflow 运行态
 * @returns 可比较的状态对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function comparableRun(run: WorkflowRun): unknown {
  return { ...run, action: undefined, confirmation: { state: run.confirmation.state, confirmedAt: run.confirmation.confirmedAt } };
}

/**
 * 生成下一个 step 序号。
 * @param snapshot - durable 快照
 * @returns 新序号
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function nextSequence(snapshot: DurableWorkflowSnapshot): number {
  return snapshot.steps.length + 1;
}

/**
 * 生成不重复的非 Action step ID。
 * @param snapshot - durable 快照
 * @param operation - 操作类型
 * @returns step ID
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function nextStepId(snapshot: DurableWorkflowSnapshot, operation: DurableStepOperation): string {
  return `workflow-step-${snapshot.steps.length + 1}-${operation}`;
}

/**
 * 创建成功的 WorkflowResult。
 * @param value - 成功值
 * @returns 深拷贝成功结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function success<T>(value: T): WorkflowResult<T> {
  return { ok: true, value: structuredClone(value) };
}

/**
 * 创建稳定失败的 WorkflowResult。
 * @param reasonCode - 稳定拒绝码
 * @returns 失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function failure<T>(reasonCode: string): WorkflowResult<T> {
  return { ok: false, reasonCode };
}

/**
 * 判断值是否为非数组对象。
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
