/**
 * 提供 durable Workflow 快照的内存实现和输入边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract } from '@iar/contracts';
import type { DurableWorkflowSnapshot, DurableWorkflowStore } from './types.js';

/**
 * 适合测试和嵌入式演练的深拷贝内存 store。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class InMemoryDurableWorkflowStore implements DurableWorkflowStore {
  private readonly snapshots = new Map<string, DurableWorkflowSnapshot>();

  /**
   * 读取指定 Workflow 的快照副本。
   * @param runId - Workflow 运行标识
   * @returns 深拷贝快照或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async load(runId: string): Promise<DurableWorkflowSnapshot | undefined> {
    const snapshot = this.snapshots.get(runId);
    // 未创建的 run 按 store contract 返回 undefined。
    if (!snapshot) return undefined;
    validateDurableSnapshot(snapshot);
    return structuredClone(snapshot);
  }

  /**
   * 只在 runId 尚不存在时创建首个快照。
   * @param snapshot - 初始持久状态
   * @returns 是否成功创建
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async create(snapshot: DurableWorkflowSnapshot): Promise<boolean> {
    validateDurableSnapshot(snapshot);
    // create 是同一 run 的唯一初始写入点。
    if (this.snapshots.has(snapshot.run.runId)) return false;
    this.snapshots.set(snapshot.run.runId, structuredClone(snapshot));
    return true;
  }

  /**
   * 校验并保存 Workflow 快照副本。
   * @param snapshot - 待保存的持久状态
   * @returns 无返回值
   * @throws Error 当快照边界无效时
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async save(snapshot: DurableWorkflowSnapshot, expectedVersion: number): Promise<void> {
    validateDurableSnapshot(snapshot);
    const existing = this.snapshots.get(snapshot.run.runId);
    // CAS 失败时不得覆盖另一个 worker 已提交的版本。
    if (!existing || existing.version !== expectedVersion) throw new Error('durable_snapshot_conflict');
    this.snapshots.set(snapshot.run.runId, structuredClone(snapshot));
  }
}

/**
 * 校验 store 不会保存跨 Workflow 或重复 step 的状态。
 * @param snapshot - 未信任快照
 * @returns 无返回值
 * @throws Error 当快照不满足持久化边界时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validateDurableSnapshot(snapshot: unknown): asserts snapshot is DurableWorkflowSnapshot {
  try {
    validateSnapshot(snapshot);
  } catch {
    throw new Error('durable_snapshot_invalid');
  }
}

/**
 * 执行 durable 快照的完整结构校验。
 * @param snapshot - 未信任快照
 * @returns 无返回值
 * @throws Error 当快照不满足恢复边界时
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateSnapshot(snapshot: unknown): asserts snapshot is DurableWorkflowSnapshot {
  // 快照外壳和 run 必须先满足普通对象边界。
  if (!isRecord(snapshot) || !isRecord(snapshot.run)) throw new Error('durable_snapshot_invalid');
  const value = snapshot as DurableWorkflowSnapshot;
  // runId 是跨 step、Action 和 event 关联的根身份。
  if (typeof value.run.runId !== 'string' || value.run.runId.length === 0) throw new Error('durable_snapshot_invalid');
  // version、事件序号和数组外壳必须是有限的持久化结构。
  if (!Number.isInteger(value.version) || value.version < 1 || !Number.isInteger(value.nextEventSequence) || value.nextEventSequence < 1 || !Array.isArray(value.steps) || !Array.isArray(value.actions) || !Array.isArray(value.events)) throw new Error('durable_snapshot_invalid');
  // run 状态和 WorkflowDefinition 必须同时可恢复。
  if (!validateRun(value) || !validateContract('workflow', value.run.definition).ok) throw new Error('durable_snapshot_invalid');
  const stepIds = value.steps.map((step) => step.stepId);
  // stepId 唯一性防止同一个副作用被多个记录覆盖。
  if (stepIds.some((stepId) => typeof stepId !== 'string' || stepId.length === 0) || new Set(stepIds).size !== stepIds.length) throw new Error('durable_snapshot_invalid');
  const eventIds = value.events.map((event) => event.eventId);
  // event id 和 next sequence 必须保持单调且无重复。
  if (new Set(eventIds).size !== eventIds.length || value.nextEventSequence !== value.events.length + 1) throw new Error('durable_snapshot_invalid');
  // step、Action 和 event 必须同时通过各自的跨对象关联校验。
  if (!validateSteps(value) || !validateActions(value) || value.events.some((event) => !validateEvent(event, value.run.runId))) throw new Error('durable_snapshot_invalid');
}

/**
 * 校验运行态的状态、定义和 Action 归属。
 * @param snapshot - 未信任快照
 * @returns 是否为可恢复运行态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateRun(snapshot: DurableWorkflowSnapshot): boolean {
  const run = snapshot.run;
  // WorkflowDefinition 必须是可读取的普通对象。
  if (!isRecord(run.definition)) return false;
  const statuses = new Set(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']);
  const actionStatuses = new Set(['accepted', 'in_progress', 'succeeded', 'failed', 'cancelled']);
  const confirmationStates = new Set(['not_required', 'required', 'confirmed', 'rejected']);
  const confirmation = run.confirmation;
  const validError = run.lastError === undefined || (typeof run.lastError.code === 'string' && run.lastError.code.length > 0 && typeof run.lastError.retryable === 'boolean');
  const validConfirmation = isRecord(confirmation) && confirmationStates.has(confirmation.state) && (confirmation.scopeHash === undefined || typeof confirmation.scopeHash === 'string') && (confirmation.confirmedAt === undefined || typeof confirmation.confirmedAt === 'string');
  const validActionStatus = run.actionStatus === undefined || actionStatuses.has(run.actionStatus);
  return statuses.has(run.status) && typeof run.workflowId === 'string' && run.workflowId.length > 0 && typeof run.currentStep === 'string' && run.currentStep.length > 0 && run.definition.workflowId === run.workflowId && run.definition.states.includes(run.currentStep) && Number.isInteger(run.attempts) && run.attempts >= 0 && validError && validConfirmation && validActionStatus && (run.action === undefined || (run.action.runId === run.runId && isRedactedValue(run.action.input) && validateContract('action', run.action).ok));
}

/**
 * 校验 step 的序号、操作和 run 归属。
 * @param snapshot - 未信任快照
 * @returns 是否满足 step 持久化边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateSteps(snapshot: DurableWorkflowSnapshot): boolean {
  const runId = snapshot.run.runId;
  const sequences = snapshot.steps.map((step) => step.sequence);
  // 每个 step 必须有正整数且唯一的序号。
  if (sequences.some((sequence) => !Number.isInteger(sequence) || sequence < 1) || new Set(sequences).size !== sequences.length) return false;
  // 序号必须连续，且不能越过当前 snapshot version。
  if (sequences.some((sequence, index) => sequence !== index + 1) || (sequences.length > 0 && Math.max(...sequences) >= snapshot.version + 1)) return false;
  return snapshot.steps.every((step) => validStepData(step, runId));
}

/**
 * 校验单个 step 的 discriminated union 和 run 归属。
 * @param step - 未信任 step
 * @param runId - Workflow 运行标识
 * @returns 是否为合法 step
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validStepData(step: DurableWorkflowSnapshot['steps'][number], runId: string): boolean {
  // step status 和 discriminated union operation 必须相互匹配。
  if (step.status !== 'pending' && step.status !== 'completed') return false;
  if (step.data.kind !== step.operation) return false;
  // start step 只能是序号一，保证恢复从唯一根节点开始。
  if (step.data.kind === 'start') return step.sequence === 1;
  // transition 的事件名必须是非空公开状态输入。
  if (step.data.kind === 'transition') return step.data.event.length > 0;
  // confirm 必须绑定当前 run，且 Action input 已脱敏并符合 Schema。
  if (step.data.kind === 'confirm') return step.data.input.runId === runId && isRedactedValue(step.data.input.action.input) && validateContract('action', step.data.input.action).ok;
  // execute 必须绑定当前 run，并携带可重放的安全请求。
  if (step.data.kind === 'execute') return step.data.request.runId === runId && step.data.request.action.runId === runId && isRedactedValue(step.data.request.action.input) && validateContract('action', step.data.request.action).ok;
  // fail 必须保留稳定错误码，不能把异常对象写入快照。
  if (step.data.kind === 'fail') return step.data.input.runId === runId && step.data.input.errorCode.length > 0;
  // retry、timeout、cancel、resume 只允许引用当前 run。
  return step.data.runId === runId;
}

/**
 * 校验 Action 的 run、幂等和结果边界。
 * @param snapshot - 未信任快照
 * @returns 是否满足 Action 持久化边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateActions(snapshot: DurableWorkflowSnapshot): boolean {
  return snapshot.actions.every((record) => {
    const step = snapshot.steps.find((candidate) => candidate.stepId === record.request.stepId);
    const validOutcome = record.outcome === undefined || (record.outcome.ok ? record.outcome.value.actionId === record.request.action.actionId && (record.outcome.value.output === undefined || isRedactedValue(record.outcome.value.output)) && validateContract('actionResult', record.outcome.value).ok : typeof record.outcome.reasonCode === 'string' && record.outcome.reasonCode.length > 0);
    const matchingStep = step?.data.kind === 'execute' && step.data.request.stepId === record.request.stepId && step.data.request.action.idempotencyKey === record.request.action.idempotencyKey;
    return matchingStep && step.status === record.status && record.request.runId === snapshot.run.runId && record.request.action.runId === snapshot.run.runId && isRedactedValue(record.request.action.input) && typeof record.request.stepId === 'string' && record.request.stepId.length > 0 && validateContract('action', record.request.action).ok && typeof record.actionDigest === 'string' && record.actionDigest.startsWith('sha256:') && (record.status === 'pending' ? record.outcome === undefined : record.outcome !== undefined && validOutcome);
  });
}

/**
 * 校验事件属于当前 Workflow 且满足公共 EventEnvelope Schema。
 * @param event - 未信任事件
 * @param runId - Workflow 运行标识
 * @returns 是否为合法事件
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateEvent(event: unknown, runId: string): boolean {
  // 跨 run 或非公共 EventEnvelope 的事件不能进入 durable history。
  if (!isRecord(event) || event.runId !== runId || !validateContract('event', event).ok) return false;
  // 非对象 payload 没有约定 input/output 字段，保持其合法 JSON 形状。
  if (!isRecord(event.payload)) return true;
  // 对象 payload 的敏感字段必须已经被摘要化。
  return (!('input' in event.payload) || isRedactedValue(event.payload.input)) && (!('output' in event.payload) || isRedactedValue(event.payload.output));
}

/**
 * 判断值是否为 durable 输入/输出摘要。
 * @param value - 未信任 JSON 值
 * @returns 是否为安全摘要对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRedactedValue(value: unknown): boolean {
  return isRecord(value) && value.redacted === true && typeof value.digest === 'string' && value.digest.startsWith('sha256:');
}

/**
 * 判断值是否为非数组对象。
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
