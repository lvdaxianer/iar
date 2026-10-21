/**
 * 提供本地确定性 Workflow 状态机、Policy Gate 和 Action 幂等执行门禁。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { type ActionResult, type EventEnvelope } from '@iar/contracts';
import { ActionIdempotencyLedger } from '../session/action-idempotency.js';
import { ActionExecutionService } from './action-execution.js';
import { WorkflowEventLog } from './event-log.js';
import { confirmationScopeHash } from './policy-gate.js';
import { cloneWorkflowRun, type ConfirmationRequest, type ExecuteRequest, type FailureRequest, type WorkflowRequest, type WorkflowResult, type WorkflowRun } from './types.js';
import { failure, isRecord, isTerminal, validAction, validConfirmationInput, validDefinition, validFailureInput, validRunId, validTransitionInput, success, workflowDefinition } from './workflow-support.js';

/** 本地 Workflow 的可注入依赖。 */
export type LocalWorkflowOptions = {
  /** 可复用的 Action 幂等账本。 */
  ledger?: ActionIdempotencyLedger;
  /** 可注入的本地可重放事件 sink。 */
  eventLog?: WorkflowEventLog;
};

/**
 * 管理内存中的确定性 Workflow 实例。
 *
 * 该类不执行未通过 Policy/confirmation/幂等门禁的 Action。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class LocalWorkflow {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly execution: ActionExecutionService;
  private readonly eventLog: WorkflowEventLog;

  /**
   * 创建本地 Workflow 服务。
   *
   * @param options - 可选幂等账本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: LocalWorkflowOptions = {}) {
    this.eventLog = options.eventLog ?? new WorkflowEventLog();
    this.execution = new ActionExecutionService({ runs: this.runs, ledger: options.ledger ?? new ActionIdempotencyLedger(), eventLog: this.eventLog });
  }

  /**
   * 返回本地 Workflow 产生的深拷贝事件。
   * @returns 版本化 EventEnvelope 快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get events(): readonly EventEnvelope[] {
    return this.eventLog.events;
  }

  /**
   * 校验并启动一个 Workflow 实例。
   *
   * @param request - runId 和版本化 WorkflowDefinition
   * @returns 初始 running 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public start(request: WorkflowRequest): WorkflowResult<WorkflowRun> {
    // WorkflowDefinition 和 runId 必须先通过运行时校验。
    if (!validDefinition(request)) return failure('workflow_definition_invalid');
    // 重复 runId 不能覆盖已有运行态。
    if (this.runs.has(request.runId)) return failure('workflow_exists');
    const run: WorkflowRun = { runId: request.runId, workflowId: request.definition.workflowId, definition: structuredClone(request.definition), currentStep: request.definition.initialState, status: 'running', attempts: 0, confirmation: { state: 'not_required' } };
    this.runs.set(request.runId, run);
    this.eventLog.workflowStarted(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 读取 Workflow 的深拷贝快照。
   *
   * @param runId - Workflow 实例标识
   * @returns 当前快照或稳定不存在结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get(runId: string): WorkflowResult<WorkflowRun> {
    const run = this.runs.get(runId);
    return run ? success(cloneWorkflowRun(run)) : failure('workflow_not_found');
  }

  /**
   * 根据显式 transition 推进当前状态机节点。
   *
   * @param input - runId 和稳定事件名
   * @returns 转移后的快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public transition(input: { runId: string; event: string }): WorkflowResult<WorkflowRun> {
    // malformed 状态事件不能读取 Map 或进入状态机。
    if (!validTransitionInput(input)) return failure('workflow_input_invalid');
    const run = this.runs.get(input.runId);
    // 未知 run 不得创建隐式状态。
    if (!run) return failure('workflow_not_found');
    // 终态不能接受任何后续事件。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    // waiting 必须先 retry/resume，不能直接推进业务步骤。
    if (run.status === 'waiting') return failure('workflow_waiting');
    const definition = workflowDefinition(run);
    const transition = definition.transitions.find((item) => item.from === run.currentStep && item.event === input.event);
    // 未声明的 from/event 边必须拒绝。
    if (!transition) return failure('workflow_transition_invalid');
    run.currentStep = transition.to;
    run.status = definition.terminalStates.includes(transition.to) ? 'completed' : 'running';
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 写入当前 Action 的 confirmation scope。
   *
   * @param input - Action、scope hash 和确认时间
   * @returns 确认后的 Workflow 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public confirm(input: ConfirmationRequest): WorkflowResult<WorkflowRun> {
    // Action、runId、scopeHash 和时间必须先通过运行时结构校验。
    if (!validConfirmationInput(input)) return failure('confirmation_input_invalid');
    if (!isRecord(input) || !isRecord(input.action) || !validAction(input.action)) return failure('action_invalid');
    const run = this.runs.get(input.runId);
    // 未知 run 不得创建确认上下文。
    if (!run) return failure('workflow_not_found');
    // 终态不能追加确认。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    // Confirmation 只能绑定当前 Workflow 的 Action。
    if (input.action.runId !== input.runId) return failure('action_run_mismatch');
    // scope hash 不匹配时保持原确认状态。
    if (input.scopeHash !== confirmationScopeHash(input.action)) return failure('confirmation_scope_mismatch');
    run.action = structuredClone(input.action);
    run.confirmation = { state: 'confirmed', scopeHash: input.scopeHash, confirmedAt: input.confirmedAt };
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 经过 Policy、confirmation 和幂等门禁后调用 executor。
   *
   * @param input - Action、授权能力、确认上下文和 executor
   * @returns ActionResult 或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async execute(input: ExecuteRequest): Promise<WorkflowResult<ActionResult>> {
    return this.execution.execute(input);
  }

  /**
   * 记录一次可恢复或永久失败。
   *
   * @param input - 错误码和 retryable 分类
   * @returns 更新后的 Workflow 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public fail(input: FailureRequest): WorkflowResult<WorkflowRun> {
    // 错误码和 retryable 必须保持稳定运行时类型。
    if (!validFailureInput(input)) return failure('workflow_input_invalid');
    const run = this.runs.get(input.runId);
    // 未知 run 不得写入失败状态。
    if (!run) return failure('workflow_not_found');
    // 终态不能被新的失败覆盖。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    run.lastError = { code: input.errorCode, retryable: input.retryable };
    run.status = input.retryable ? 'waiting' : 'failed';
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 将 retryable waiting 状态恢复为 running。
   *
   * @param runId - Workflow 实例标识
   * @returns 恢复后的快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public retry(runId: string): WorkflowResult<WorkflowRun> {
    // retry 只接受有效的稳定 runId。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    const run = this.runs.get(runId);
    // 未知 run 不得创建恢复上下文。
    if (!run) return failure('workflow_not_found');
    // 终态不能恢复。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    // 只有 waiting 且错误可重试时才推进 attempts。
    if (run.status !== 'waiting' || !run.lastError?.retryable) return failure('workflow_not_retryable');
    run.status = 'running';
    run.attempts += 1;
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 将当前 Workflow 标记为 timeout 终态。
   *
   * @param runId - Workflow 实例标识
   * @returns failed 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public timeout(runId: string): WorkflowResult<WorkflowRun> {
    // timeout 输入必须绑定有效 runId。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    return this.fail({ runId, errorCode: 'workflow.timeout', retryable: false });
  }

  /**
   * 将当前 Workflow 标记为 cancelled 终态。
   *
   * @param runId - Workflow 实例标识
   * @returns cancelled 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public cancel(runId: string): WorkflowResult<WorkflowRun> {
    // cancel 输入必须绑定有效 runId。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    const run = this.runs.get(runId);
    // 未知 run 不得创建取消状态。
    if (!run) return failure('workflow_not_found');
    // 终态不能重复取消。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    run.status = 'cancelled';
    run.lastError = { code: 'workflow.cancelled', retryable: false };
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }

  /**
   * 从 waiting/running 状态恢复本地 Workflow。
   *
   * @param runId - Workflow 实例标识
   * @returns running 快照或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public resume(runId: string): WorkflowResult<WorkflowRun> {
    // resume 输入必须绑定有效 runId。
    if (!validRunId(runId)) return failure('workflow_input_invalid');
    const run = this.runs.get(runId);
    // 未知 run 不得创建恢复上下文。
    if (!run) return failure('workflow_not_found');
    // 终态不能被 resume 绕过。
    if (isTerminal(run.status)) return failure('workflow_terminal');
    if (run.status === 'waiting') run.status = 'running';
    this.eventLog.workflowTransitioned(run);
    return success(cloneWorkflowRun(run));
  }
}
