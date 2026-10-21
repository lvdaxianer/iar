/**
 * 隔离 Action 的 Policy、幂等、竞态和 executor 调用流程。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type ActionDefinition, type ActionResult } from '@iar/contracts';
import { ActionIdempotencyLedger } from '../action-idempotency.js';
import { WorkflowEventLog } from './event-log.js';
import { PolicyGate, confirmationScopeHash } from './policy-gate.js';
import { type ExecuteRequest, type WorkflowResult, type WorkflowRun } from './types.js';
import { failure, isRecord, isTerminal, success, validAction, validRunId } from './workflow-support.js';

/** Action 执行器访问的最小本地状态集合。 */
export type ActionExecutionDependencies = {
  /** 当前 Workflow 内部运行态。 */
  runs: Map<string, WorkflowRun>;
  /** 原子 Action 幂等账本。 */
  ledger: ActionIdempotencyLedger;
  /** Action 结果和拒绝路径的事件 sink。 */
  eventLog: WorkflowEventLog;
};

/**
 * 执行 Policy → Idempotency → Race check → Executor 的固定顺序。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ActionExecutionService {
  private readonly policy = new PolicyGate();
  private readonly actionResults = new Map<string, ActionResult>();
  private readonly actionIdentities = new Map<string, ActionDefinition>();

  /**
   * 创建 Action 执行服务。
   *
   * @param dependencies - Workflow 状态和幂等依赖
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly dependencies: ActionExecutionDependencies) {}

  /**
   * 经过 Policy、confirmation、幂等和状态竞态检查后调用 executor。
   *
   * @param input - Action、授权能力、confirmation 和 executor
   * @returns 第一次 ActionResult 或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async execute(input: ExecuteRequest): Promise<WorkflowResult<ActionResult>> {
    const preflight = this.preflight(input);
    if (!preflight.ok) return preflight.result;
    if (preflight.replay) return preflight.replay;
    return this.executeApproved(input, preflight.run);
  }

  /**
   * 在任何幂等重放或 ledger 写入前完成请求、状态和策略校验。
   *
   * @param input - 未信任的执行请求
   * @returns 可执行运行态、重放结果或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private preflight(input: ExecuteRequest): ExecutionPreflight {
    // 外部请求和 Action 必须先通过普通对象与公共 Schema 边界。
    if (!isRecord(input) || !isRecord(input.action)) return this.reject(input, 'workflow_input_invalid');
    // runId、executor 和 retryable 不允许依赖 TypeScript 类型擦除后的值。
    if (!validAction(input.action) || !validRunId(input.runId)) return this.reject(input, 'policy_input_invalid');
    if (typeof input.executor !== 'function' || !validRetryable(input.retryable)) return this.reject(input, 'workflow_input_invalid');
    const run = this.dependencies.runs.get(input.runId);
    // 未知 run 不得创建隐式执行上下文。
    if (!run) return this.reject(input, 'workflow_not_found');
    // Action 只能绑定发起它的 Workflow 实例。
    if (input.action.runId !== input.runId) return this.reject(input, 'action_run_mismatch');
    const policy = this.policy.evaluate(input, run.confirmation);
    // duplicate replay 也必须重新经过当前授权、能力和 confirmation 校验。
    if (!policy.ok) return this.reject(input, policy.reasonCode);
    const replay = this.replayKnown(input.action);
    if (replay) return { ok: true, run, replay };
    // 终态只允许已经通过 Policy 的既有结果重放。
    if (isTerminal(run.status)) return this.reject(input, 'workflow_terminal');
    // waiting 必须先显式 retry/resume，不能绕过恢复边界。
    if (run.status === 'waiting') return this.reject(input, 'workflow_waiting');
    return { ok: true, run };
  }

  /**
   * 记录合法 Action 的前置拒绝并返回稳定结果。
   * @param input - 未信任的执行请求
   * @param reasonCode - 宿主可消费的稳定拒绝原因
   * @returns 前置检查失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private reject(input: ExecuteRequest, reasonCode: string): ExecutionPreflight {
    const run = isRecord(input) && validRunId(input.runId) ? this.dependencies.runs.get(input.runId) : undefined;
    const actionMatchesRun = isRecord(input) && validAction(input.action) && validRunId(input.runId) && input.action.runId === input.runId;
    if (run && actionMatchesRun) this.dependencies.eventLog.actionFailed(input.action, reasonCode, reasonCode);
    return rejected(reasonCode);
  }

  /**
   * 在 Workflow 仍为 running 时写入幂等键并执行 Action。
   *
   * @param input - 已通过策略的执行请求
   * @param run - 当前内部运行态
   * @returns 第一次 ActionResult 或幂等结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async executeApproved(input: ExecuteRequest, run: WorkflowRun): Promise<WorkflowResult<ActionResult>> {
    const started = await this.startIdempotent(input.action);
    // 幂等账本异常不能伪装成重复提交。
    if (started.reasonCode) {
      this.dependencies.eventLog.actionFailed(input.action, started.reasonCode, started.reasonCode);
      return failure(started.reasonCode);
    }
    // 已有记录必须先校验 Action 身份，再决定重放结果。
    if (!started.ok) return this.duplicateResult(input.action, started.existing);
    this.actionIdentities.set(input.action.idempotencyKey, structuredClone(input.action));
    this.dependencies.eventLog.actionStarted(input.action);
    // ledger.start 是异步边界，完成后必须重新确认没有 cancel/timeout 竞态。
    if (run.status !== 'running') return this.recordStateRace(input, run);
    return this.callExecutor(input, run);
  }

  /**
   * 将幂等账本异常转换成稳定结果。
   *
   * @param action - 待写入幂等账本的 Action
   * @returns 首次写入成功或稳定失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async startIdempotent(action: ActionDefinition): Promise<{ ok: true; reasonCode?: undefined } | { ok: false; existing: ActionDefinition; reasonCode?: undefined } | { ok: false; reasonCode: 'action_idempotency_failed' }> {
    try {
      const started = await this.dependencies.ledger.start(action);
      return started.ok ? { ok: true } : { ok: false, existing: started.existing };
    } catch {
      return { ok: false, reasonCode: 'action_idempotency_failed' };
    }
  }

  /**
   * 处理幂等键已存在的重复提交。
   *
   * @param key - Action 幂等键
   * @param existing - 第一次写入的 Action
   * @returns 第一次结果、进行中或稳定重复结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private duplicateResult(action: ActionDefinition, existing: ActionDefinition): WorkflowResult<ActionResult> {
    // 同一幂等键不能绑定不同的 Action 身份或输入。
    if (confirmationScopeHash(action) !== confirmationScopeHash(existing)) {
      this.dependencies.eventLog.actionFailed(action, 'idempotency_key_conflict', 'idempotency_key_conflict');
      return failure('idempotency_key_conflict');
    }
    const result = this.actionResults.get(action.idempotencyKey);
    // 已有完整结果时直接返回深拷贝，禁止第二次副作用。
    if (result) {
      if (result.status === 'failed') this.dependencies.eventLog.actionFailed(action, result.errorCode ?? 'action.failed', 'action_duplicate');
      else this.dependencies.eventLog.actionCompleted(action, result, 'action_duplicate');
      return { ok: true, value: structuredClone(result), reasonCode: 'action_duplicate' };
    }
    // 只有 Action 记录而没有结果时，表示第一次执行仍未收敛。
    this.dependencies.eventLog.actionFailed(action, 'action.in_progress', 'action_in_progress');
    return { ok: false, reasonCode: 'action_in_progress', existing: structuredClone(existing) };
  }

  /**
   * 查找已完成 Action 的可重放结果。
   *
   * @param action - 当前请求 Action
   * @returns 重放结果或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private replayKnown(action: ActionDefinition): WorkflowResult<ActionResult> | undefined {
    const existing = this.actionIdentities.get(action.idempotencyKey);
    return existing ? this.duplicateResult(action, existing) : undefined;
  }

  /**
   * 调用 executor 并校验其结果仍绑定当前 Action。
   *
   * @param input - 执行器和 retryable 策略
   * @param run - 当前内部运行态
   * @returns 已校验 ActionResult 或稳定失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private callExecutor(input: ExecuteRequest, run: WorkflowRun): WorkflowResult<ActionResult> {
    let result: ActionResult;
    try {
      result = input.executor(structuredClone(input.action));
    } catch {
      // executor 异常是永久失败，结果仍需进入幂等结果表。
      return this.recordFailure(input, run, 'action.executor_failed', 'action_executor_failed');
    }
    const validation = validateContract('actionResult', result);
    // 非法结果不能进入 Workflow 或被调用方当作成功。
    if (!validation.ok || !isActionResultFor(validation.value, input.action.actionId)) return this.recordFailure(input, run, 'action.result_invalid', 'action_result_invalid');
    return this.recordResult(input, run, validation.value);
  }

  /**
   * 记录通过 Schema 的 ActionResult，并更新 retryable 状态。
   *
   * @param input - Action 和 retry 策略
   * @param run - 当前内部运行态
   * @param result - 已验证结果
   * @returns 深拷贝结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private recordResult(input: ExecuteRequest, run: WorkflowRun, result: ActionResult): WorkflowResult<ActionResult> {
    run.action = structuredClone(input.action);
    run.actionStatus = result.status;
    if (result.status === 'failed') {
      run.lastError = { code: result.errorCode ?? 'action.failed', retryable: input.retryable === true };
      run.status = input.retryable === true ? 'waiting' : 'failed';
    }
    this.actionResults.set(input.action.idempotencyKey, structuredClone(result));
    if (result.status === 'failed') this.dependencies.eventLog.actionFailed(input.action, result.errorCode ?? 'action.failed', result.errorCode ?? 'action_failed');
    else this.dependencies.eventLog.actionCompleted(input.action, result);
    return success(structuredClone(result));
  }

  /**
   * 将 executor 异常或 malformed 结果固化为失败结果。
   *
   * @param input - 原始 Action 请求
   * @param run - 当前内部运行态
   * @param errorCode - 记录到 Workflow 的错误码
   * @param reasonCode - 对调用方公开的稳定码
   * @returns 稳定失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private recordFailure(input: ExecuteRequest, run: WorkflowRun, errorCode: string, reasonCode: string): WorkflowResult<ActionResult> {
    const result = failureActionResult(input.action, errorCode);
    run.action = structuredClone(input.action);
    run.actionStatus = 'failed';
    run.lastError = { code: errorCode, retryable: false };
    run.status = 'failed';
    this.actionIdentities.set(input.action.idempotencyKey, structuredClone(input.action));
    this.actionResults.set(input.action.idempotencyKey, result);
    this.dependencies.eventLog.actionFailed(input.action, errorCode, reasonCode);
    return failure(reasonCode);
  }

  /**
   * 记录 ledger 预占后发现 Workflow 状态变化的补偿结果。
   *
   * @param input - 已预占幂等键的 Action 请求
   * @param run - 已被 cancel/timeout 的运行态
   * @returns 稳定状态竞态失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private recordStateRace(input: ExecuteRequest, run: WorkflowRun): WorkflowResult<ActionResult> {
    const result = failureActionResult(input.action, 'workflow.state_changed');
    run.action = structuredClone(input.action);
    run.actionStatus = 'failed';
    run.lastError = { code: run.lastError?.code ?? 'workflow.state_changed', retryable: false };
    this.actionIdentities.set(input.action.idempotencyKey, structuredClone(input.action));
    this.actionResults.set(input.action.idempotencyKey, result);
    this.dependencies.eventLog.actionFailed(input.action, 'workflow.state_changed', 'workflow_state_changed');
    return failure('workflow_state_changed');
  }
}

/**
 * 构造 executor 失败的幂等结果。
 *
 * @param action - 原始 Action
 * @param errorCode - 稳定失败码
 * @returns 可供重复提交返回的失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function failureActionResult(action: ActionDefinition, errorCode: string): ActionResult {
  return { schemaVersion: action.schemaVersion, actionId: action.actionId, status: 'failed', errorCode };
}

/**
 * 判断 executor 结果是否绑定当前 Action。
 * @param value - 未信任的 executor 返回值
 * @param actionId - 当前 Action 标识
 * @returns 是否保持 Action 归属
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isActionResultFor(value: unknown, actionId: string): value is ActionResult {
  return isRecord(value) && value.actionId === actionId;
}

/**
 * 描述执行前检查的三种结果。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
type ExecutionPreflight =
  | { ok: false; result: WorkflowResult<ActionResult> }
  | { ok: true; run: WorkflowRun; replay?: WorkflowResult<ActionResult> };

/**
 * 判断 retryable 是否缺省或为布尔值。
 * @param value - 未信任的 retryable 输入
 * @returns 是否为合法 retryable
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validRetryable(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

/**
 * 生成执行前置检查的失败分支。
 * @param reasonCode - 稳定拒绝原因
 * @returns 前置检查失败结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function rejected(reasonCode: string): ExecutionPreflight {
  return { ok: false, result: failure(reasonCode) };
}
