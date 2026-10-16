/**
 * 提供可从持久步骤恢复的 Temporal-compatible WorkflowRuntime。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { type ActionResult, type EventEnvelope } from '@iar/contracts';
import { PolicyGate, type ActionExecutor, type ConfirmationRequest, type FailureRequest, type WorkflowRequest, type WorkflowResult, type WorkflowRun } from '@iar/workflow';
import { assertWorkflowRuntimeOptions } from './contract-runtime.js';
import { evaluateDurableAdmission } from './admission.js';
import { InMemoryDurableWorkflowStore } from './durable-store.js';
import { failure, isDurableExecuteRequest, isRecord, safeRunId, success, validRunId, validTransitionInput } from './durable-runtime-support.js';
import { invalidateRun, loadRun, mutate, replayOrExecute, startInternal, type DurableRuntimeContext } from './durable-runtime-operations.js';
import type { DurableExecuteRequest, DurableWorkflowRuntimeOptions, WorkflowRuntimeContract } from './types.js';

/**
 * 复用 LocalWorkflow 语义并把每个可观察步骤保存到 DurableWorkflowStore。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class DurableWorkflowEngine implements WorkflowRuntimeContract {
  /** 适配器名称。 */
  public readonly adapterName: string;
  /** 适配器契约版本。 */
  public readonly adapterVersion: 'v1';
  private readonly context: DurableRuntimeContext;

  /**
   * 创建带显式 durable requirement 的 runtime。
   * @param options - adapter、准入需求和持久化 store
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: DurableWorkflowRuntimeOptions) {
    const config = (() => {
      try {
        assertWorkflowRuntimeOptions(options);
        return { adapterName: options.adapterName, adapterVersion: options.adapterVersion, requirement: structuredClone(options.requirement), store: options.store };
      } catch {
        // 恶意 getter、revoked Proxy 或不可克隆配置不得泄露底层异常。
        throw new Error('durable_adapter_configuration_invalid');
      }
    })();
    const admission = evaluateDurableAdmission(config.requirement);
    // 未满足 timer/cross-service/compensation 准入的 Workflow 不能进入 durable runtime。
    if (!admission.admitted) throw new Error(admission.reasonCode);
    this.adapterName = config.adapterName;
    this.adapterVersion = config.adapterVersion;
    this.context = { adapterName: config.adapterName, requirement: config.requirement, store: config.store ?? new InMemoryDurableWorkflowStore(), snapshots: new Map(), locals: new Map(), eventCursors: new Map(), policy: new PolicyGate() };
  }

  /**
   * 经过 durable 准入后创建并持久化 Workflow。
   * @param request - Workflow 启动请求
   * @returns 初始运行快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async start(request: WorkflowRequest): Promise<WorkflowResult<WorkflowRun>> {
    try {
      return await startInternal(this.context, request);
    } catch {
      return failure('durable_persistence_failed');
    }
  }

  /**
   * 读取持久化 Workflow 快照。
   * @param runId - Workflow 运行标识
   * @returns 深拷贝运行快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async get(runId: string): Promise<WorkflowResult<WorkflowRun>> {
    // 非法 runId 在访问持久化边界前稳定拒绝。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    const loaded = await loadRun(this.context, runId);
    return loaded.ok ? success(loaded.value.snapshot.run) : failure(loaded.reasonCode);
  }

  /**
   * 返回持久化的 IAR 事件序列。
   * @param runId - Workflow 运行标识
   * @returns 事件深拷贝或空数组
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async events(runId: string): Promise<readonly EventEnvelope[]> {
    // 非法 runId 不得触发 store 查询。
    if (!validRunId(runId)) return [];
    const loaded = await loadRun(this.context, runId);
    return loaded.ok ? structuredClone(loaded.value.snapshot.events) : [];
  }

  /**
   * 持久化一个确定性的状态转移。
   * @param input - runId 和状态机事件
   * @returns 转移后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async transition(input: { runId: string; event: string }): Promise<WorkflowResult<WorkflowRun>> {
    let safeInput: { runId: string; event: string };
    try {
      // transition 外围字段必须先通过运行时校验。
      if (!validTransitionInput(input)) return failure('workflow_input_invalid');
      // 在同一个保护边界内固定字段，避免有状态 Proxy 在后续读取时改变语义。
      safeInput = { runId: input.runId, event: input.event };
    } catch {
      // revoked Proxy 等恶意输入统一按非法请求处理。
      return failure('workflow_input_invalid');
    }
    return mutate(this.context, safeInput.runId, 'transition', { kind: 'transition', event: safeInput.event }, (local) => local.transition(safeInput));
  }

  /**
   * 持久化当前 Action 的 confirmation scope。
   * @param input - confirmation 请求
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async confirm(input: ConfirmationRequest): Promise<WorkflowResult<WorkflowRun>> {
    let safeInput: ConfirmationRequest;
    try {
      // confirmation 外围字段必须先通过运行时校验。
      if (!isRecord(input) || !validRunId(input.runId)) return failure('workflow_input_invalid');
      // 深拷贝确认请求，防止后续状态机读取恶意 getter。
      safeInput = structuredClone(input);
    } catch {
      // revoked Proxy 等恶意输入统一按非法请求处理。
      return failure('workflow_input_invalid');
    }
    return mutate(this.context, safeInput.runId, 'confirm', { kind: 'confirm', input: safeInput }, (local) => local.confirm(safeInput));
  }

  /**
   * 在 Policy Gate 后持久化并执行一个 Action。
   * @param input - 不含 executor 的持久化请求
   * @param executor - 真实副作用执行器
   * @returns Action 结果或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async execute(input: DurableExecuteRequest, executor: ActionExecutor): Promise<WorkflowResult<ActionResult>> {
    try {
      // executor 必须在 pending step 持久化前验证，避免非法请求消耗幂等键。
      if (!isDurableExecuteRequest(input) || typeof executor !== 'function') return failure('workflow_input_invalid');
      const loaded = await loadRun(this.context, input.runId);
      // 恢复失败时不允许把未知快照交给 executor。
      if (!loaded.ok) return failure(loaded.reasonCode);
      // 必须 await 公开异步边界，才能把持久化失败映射为稳定错误码。
      return await replayOrExecute(this.context, loaded.value, input, executor);
    } catch {
      invalidateRun(this.context, safeRunId(input));
      return failure('durable_persistence_failed');
    }
  }

  /**
   * 持久化可恢复失败状态。
   * @param input - 失败请求
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async fail(input: FailureRequest): Promise<WorkflowResult<WorkflowRun>> {
    let safeInput: FailureRequest;
    try {
      // failure 外围字段必须先通过运行时校验。
      if (!isRecord(input) || !validRunId(input.runId)) return failure('workflow_input_invalid');
      // 深拷贝失败请求，保证持久化和 LocalWorkflow 使用同一份输入。
      safeInput = structuredClone(input);
    } catch {
      // revoked Proxy 等恶意输入统一按非法请求处理。
      return failure('workflow_input_invalid');
    }
    return mutate(this.context, safeInput.runId, 'fail', { kind: 'fail', input: safeInput }, (local) => local.fail(safeInput));
  }

  /**
   * 持久化 retry 和 attempts 变化。
   * @param runId - Workflow 运行标识
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async retry(runId: string): Promise<WorkflowResult<WorkflowRun>> {
    // retry 不能从非法 runId 创建恢复上下文。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    return mutate(this.context, runId, 'retry', { kind: 'retry', runId }, (local) => local.retry(runId));
  }

  /**
   * 持久化 timeout 终态。
   * @param runId - Workflow 运行标识
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async timeout(runId: string): Promise<WorkflowResult<WorkflowRun>> {
    // timeout 不能从非法 runId 创建终态。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    return mutate(this.context, runId, 'timeout', { kind: 'timeout', runId }, (local) => local.timeout(runId));
  }

  /**
   * 持久化 cancel 终态。
   * @param runId - Workflow 运行标识
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async cancel(runId: string): Promise<WorkflowResult<WorkflowRun>> {
    // cancel 不能从非法 runId 创建终态。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    return mutate(this.context, runId, 'cancel', { kind: 'cancel', runId }, (local) => local.cancel(runId));
  }

  /**
   * 持久化显式 resume 操作。
   * @param runId - Workflow 运行标识
   * @returns 更新后的运行快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async resume(runId: string): Promise<WorkflowResult<WorkflowRun>> {
    // resume 不能从非法 runId 创建恢复上下文。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    return mutate(this.context, runId, 'resume', { kind: 'resume', runId }, (local) => local.resume(runId));
  }

}

