/**
 * durable runtime 的持久化操作实现。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { type ActionResult } from '@iar/contracts';
import { LocalWorkflow, PolicyGate, WorkflowEventLog, type ActionExecutor, type WorkflowRequest, type WorkflowResult, type WorkflowRun } from '@iar/workflow';
import { evaluateDurableAdmission } from './admission.js';
import { validateDurableSnapshot } from './durable-store.js';
import { actionDigest, createSnapshot, durableEvent, failure, findAction, isWorkflowRequest, nextSequence, nextStepId, repairLocalConfirmation, replayExisting, replaySnapshot, success, type LoadedRun } from './durable-runtime-support.js';
import { redactOutcome, redactRequest, redactRun, redactStepData } from './durable-runtime-redaction.js';
import type { DurableExecuteRequest, DurableStepData, DurableStepOperation, DurableWorkflowRuntimeOptions, DurableWorkflowSnapshot, DurableWorkflowStore } from './types.js';

/** durable runtime 操作共享的可变状态。 */
export interface DurableRuntimeContext {
  readonly adapterName: string;
  readonly requirement: DurableWorkflowRuntimeOptions['requirement'];
  readonly store: DurableWorkflowStore;
  readonly snapshots: Map<string, DurableWorkflowSnapshot>;
  readonly locals: Map<string, LocalWorkflow>;
  readonly eventCursors: Map<string, number>;
  readonly policy: PolicyGate;
}

/** 从持久化边界加载 Workflow 的结果。 */
export type LoadResult = { ok: true; value: LoadedRun } | { ok: false; reasonCode: 'workflow_not_found' | 'durable_snapshot_invalid' };

/**
 * 校验准入并原子创建初始 durable 快照。
 * @param context - durable runtime 共享状态
 * @param request - 未信任的 Workflow 启动请求
 * @returns 初始运行态或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function startInternal(context: DurableRuntimeContext, request: WorkflowRequest): Promise<WorkflowResult<WorkflowRun>> {
  // Workflow 请求必须先通过公共 Schema 和稳定 runId 校验。
  if (!isWorkflowRequest(request)) return failure('workflow_definition_invalid');
  const admission = evaluateDurableAdmission(context.requirement);
  // 不满足 durable requirement 的 Workflow 不得进入持久化运行时。
  if (!admission.admitted || admission.workflowId !== request.definition.workflowId) return failure('durable_requirement_invalid');
  // 先读用于快速拒绝，最终 create 仍负责原子并发保护。
  if (await context.store.load(request.runId)) return failure('workflow_exists');
  const local = createLocal(context, request.runId);
  const started = local.start(request);
  // LocalWorkflow 拒绝时不产生半初始化快照。
  if (!started.ok) return started;
  const snapshot = createSnapshot(started.value);
  captureEvents(context, request.runId, local, snapshot);
  // create 的 false 结果表示另一个 worker 已先创建同一 run。
  if (!await context.store.create(snapshot)) return failure('workflow_exists');
  cacheRun(context, request.runId, snapshot, local);
  return success(snapshot.run);
}

/**
 * 对 LocalWorkflow 的状态变更统一追加持久步骤。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @param operation - 持久操作类型
 * @param data - 恢复所需输入
 * @param action - 本地状态变更函数
 * @returns 更新后的运行快照或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function mutate(context: DurableRuntimeContext, runId: string, operation: DurableStepOperation, data: DurableStepData, action: (local: LocalWorkflow) => WorkflowResult<WorkflowRun>): Promise<WorkflowResult<WorkflowRun>> {
  try {
    const loaded = await loadRun(context, runId);
    // 未找到或快照无效时，不得在内存状态上继续变更。
    if (!loaded.ok) return failure(loaded.reasonCode);
    const result = action(loaded.value.local);
    // LocalWorkflow 的稳定拒绝必须原样保留，不能写入伪成功 step。
    if (!result.ok) return result;
    await commitRun(context, runId, loaded.value, operation, data, result.value);
    return success(result.value);
  } catch {
    invalidateRun(context, runId);
    return failure('durable_persistence_failed');
  }
}

/**
 * 处理已完成 Action 重放或创建 pending step 后执行新副作用。
 * @param context - durable runtime 共享状态
 * @param loaded - 已加载的 Workflow 和本地状态机
 * @param input - 已通过边界校验的 Action 请求
 * @param executor - 真实副作用执行器
 * @returns Action 结果或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function replayOrExecute(context: DurableRuntimeContext, loaded: LoadedRun, input: DurableExecuteRequest, executor: ActionExecutor): Promise<WorkflowResult<ActionResult>> {
  const policy = context.policy.evaluate(input, loaded.snapshot.run.confirmation);
  // Policy Gate 必须先于幂等重放和 pending 持久化执行。
  if (!policy.ok) return failure(policy.reasonCode);
  const existing = findAction(loaded.snapshot.actions, input.action.idempotencyKey);
  // 已有记录只走持久结果路径，禁止重新触发 executor。
  if (existing) return replayExisting(existing, input);
  await persistPendingAction(context, loaded, input);
  const repaired = repairLocalConfirmation(loaded, input);
  // 脱敏恢复后的 confirmation scope 必须与当前真实 Action 重新绑定。
  if (repaired && !repaired.ok) return failure(repaired.reasonCode);
  const result = await loaded.local.execute({ ...input, executor });
  await persistActionResult(context, loaded, input, result);
  return result;
}

/**
 * 在 executor 前保存 pending step。
 * @param context - durable runtime 共享状态
 * @param loaded - 已加载的 Workflow 和本地状态机
 * @param input - 已通过边界校验的 Action 请求
 * @returns 无返回值
 * @throws Error 当 step 或 Action 已发生冲突
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function persistPendingAction(context: DurableRuntimeContext, loaded: LoadedRun, input: DurableExecuteRequest): Promise<void> {
  const expectedVersion = loaded.snapshot.version;
  // 同一个 stepId 不能被两个并发执行占用。
  if (loaded.snapshot.steps.some((step) => step.stepId === input.stepId)) throw new Error('durable_step_conflict');
  const persistedRequest = redactRequest(input);
  loaded.snapshot.actions.push({ request: persistedRequest, actionDigest: actionDigest(input.action), status: 'pending' });
  loaded.snapshot.steps.push({ stepId: input.stepId, sequence: nextSequence(loaded.snapshot), operation: 'execute', status: 'pending', data: { kind: 'execute', request: persistedRequest } });
  loaded.snapshot.version += 1;
  await context.store.save(loaded.snapshot, expectedVersion);
}

/**
 * 保存 Action 结果和 LocalWorkflow 新状态。
 * @param context - durable runtime 共享状态
 * @param loaded - 已加载的 Workflow 和本地状态机
 * @param input - 已通过边界校验的 Action 请求
 * @param result - 本地执行结果
 * @returns 无返回值
 * @throws Error 当持久 Action 或 step 缺失
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function persistActionResult(context: DurableRuntimeContext, loaded: LoadedRun, input: DurableExecuteRequest, result: WorkflowResult<ActionResult>): Promise<void> {
  const expectedVersion = loaded.snapshot.version;
  const action = findAction(loaded.snapshot.actions, input.action.idempotencyKey);
  // 结果提交必须绑定之前保存的 pending Action。
  if (!action) throw new Error('durable_action_missing');
  action.status = 'completed';
  action.outcome = redactOutcome(result);
  const step = loaded.snapshot.steps.find((candidate) => candidate.stepId === input.stepId);
  // Action 结果和 execute step 必须成对完成。
  if (!step) throw new Error('durable_step_missing');
  step.status = 'completed';
  const current = loaded.local.get(input.runId);
  // LocalWorkflow 已返回成功态时才更新脱敏 run snapshot。
  if (current.ok) loaded.snapshot.run = redactRun(current.value);
  captureEvents(context, input.runId, loaded.local, loaded.snapshot);
  loaded.snapshot.version += 1;
  await context.store.save(loaded.snapshot, expectedVersion);
}

/**
 * 保存状态变更、事件和 completed step。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @param loaded - 已加载的 Workflow 和本地状态机
 * @param operation - 持久操作类型
 * @param data - 恢复所需输入
 * @param run - 新运行快照
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function commitRun(context: DurableRuntimeContext, runId: string, loaded: LoadedRun, operation: DurableStepOperation, data: DurableStepData, run: WorkflowRun): Promise<void> {
  const expectedVersion = loaded.snapshot.version;
  loaded.snapshot.run = redactRun(run);
  loaded.snapshot.steps.push({ stepId: nextStepId(loaded.snapshot, operation), sequence: nextSequence(loaded.snapshot), operation, status: 'completed', data: redactStepData(data) });
  captureEvents(context, runId, loaded.local, loaded.snapshot);
  loaded.snapshot.version += 1;
  await context.store.save(loaded.snapshot, expectedVersion);
}

/**
 * 读取或恢复一个 Workflow 的 LocalWorkflow。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @returns 加载结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function loadRun(context: DurableRuntimeContext, runId: string): Promise<LoadResult> {
  try {
    const cached = context.snapshots.get(runId);
    // 缓存命中时复用同一恢复上下文，避免重复产生本地事件。
    if (cached) return { ok: true, value: { snapshot: cached, local: context.locals.get(runId) as LocalWorkflow } };
    const snapshot = await context.store.load(runId);
    // 外部 store 没有 run 时保持稳定 not-found 语义。
    if (!snapshot) return { ok: false, reasonCode: 'workflow_not_found' };
    validateDurableSnapshot(snapshot);
    const durableSnapshot = structuredClone(snapshot);
    const local = createLocal(context, runId);
    // replaySnapshot 失败时由 catch 转换为稳定 durable_snapshot_invalid。
    await replaySnapshot(local, durableSnapshot);
    cacheRun(context, runId, durableSnapshot, local);
    context.eventCursors.set(runId, local.events.length);
    return { ok: true, value: { snapshot: durableSnapshot, local } };
  } catch {
    return { ok: false, reasonCode: 'durable_snapshot_invalid' };
  }
}

/**
 * 创建带有稳定 correlationId 的本地 Workflow。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @returns 可重放的本地状态机
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createLocal(context: DurableRuntimeContext, runId: string): LocalWorkflow {
  return new LocalWorkflow({ eventLog: new WorkflowEventLog({ correlationId: `${context.adapterName}:${runId}` }) });
}

/**
 * 缓存同一 Workflow 的 snapshot、local 和事件游标。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @param snapshot - durable 快照
 * @param local - 本地状态机
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function cacheRun(context: DurableRuntimeContext, runId: string, snapshot: DurableWorkflowSnapshot, local: LocalWorkflow): void {
  context.snapshots.set(runId, snapshot);
  context.locals.set(runId, local);
  context.eventCursors.set(runId, local.events.length);
}

/**
 * CAS 冲突或持久化异常后丢弃可能已突变的本地缓存。
 * @param context - durable runtime 共享状态
 * @param runId - 可能失效的 Workflow 运行标识
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function invalidateRun(context: DurableRuntimeContext, runId: string | undefined): void {
  if (runId === undefined) return;
  context.snapshots.delete(runId);
  context.locals.delete(runId);
  context.eventCursors.delete(runId);
}

/**
 * 将本地新事件映射为稳定 durable event id。
 * @param context - durable runtime 共享状态
 * @param runId - Workflow 运行标识
 * @param local - 本地状态机
 * @param snapshot - durable 快照
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function captureEvents(context: DurableRuntimeContext, runId: string, local: LocalWorkflow, snapshot: DurableWorkflowSnapshot): void {
  const cursor = context.eventCursors.get(runId) ?? 0;
  const events = local.events.slice(cursor).map((event) => durableEvent(event, runId, context.adapterName, snapshot.nextEventSequence++));
  snapshot.events.push(...events);
  context.eventCursors.set(runId, local.events.length);
}

