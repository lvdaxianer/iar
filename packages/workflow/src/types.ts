/**
 * 定义本地确定性 Workflow、Policy 和 Action 执行边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ActionDefinition, ActionResult, ConfirmationState, WorkflowDefinition, WorkflowStatus } from '@iar/contracts';

/** 启动一个本地工作流所需的定义和稳定 runId。 */
export type WorkflowRequest = {
  /** 可恢复工作流实例的稳定标识。 */
  runId: string;
  /** 通过公共 Schema 的本地状态机定义。 */
  definition: WorkflowDefinition;
};

/** 本地 Workflow 当前可查询的状态快照。 */
export type WorkflowRun = {
  /** 工作流实例标识。 */
  runId: string;
  /** 编排定义标识。 */
  workflowId: string;
  /** 恢复所需的定义快照。 */
  definition: WorkflowDefinition;
  /** 当前状态机节点。 */
  currentStep: string;
  /** 当前运行态。 */
  status: WorkflowStatus;
  /** retry 次数。 */
  attempts: number;
  /** 最近一次结构化错误。 */
  lastError?: WorkflowError;
  /** 当前动作的执行状态。 */
  actionStatus?: ActionResult['status'];
  /** 已绑定的 Action 快照。 */
  action?: ActionDefinition;
  /** 当前确认状态和 scope。 */
  confirmation: ConfirmationState;
};

/** Workflow 失败的稳定错误分类。 */
export type WorkflowError = {
  /** 机器可判断的错误码。 */
  code: string;
  /** 是否允许本地 retry/resume。 */
  retryable: boolean;
};

/** 本地 API 的显式成功或失败结果。 */
export type WorkflowResult<T> =
  | { ok: true; value: T; reasonCode?: string; existing?: ActionDefinition }
  | { ok: false; reasonCode: string; value?: undefined; existing?: ActionDefinition };

/** Policy Gate 读取的动作授权和能力输入。 */
export type PolicyRequest = {
  /** 待执行的不可变 Action。 */
  action: ActionDefinition;
  /** 规则或 Manifest 要求的能力集合。 */
  requiredCapabilities: readonly string[];
  /** 当前租户/actor 已授予的能力集合。 */
  grantedCapabilities: readonly string[];
  /** 上游授权结果，必须显式为 true。 */
  authorized: boolean;
};

/** Policy Gate 的显式结果。 */
export type PolicyResult =
  | { ok: true; scopeHash: string }
  | { ok: false; reasonCode: 'policy_input_invalid' | 'policy_unauthorized' | 'policy_capability_missing' | 'confirmation_required' | 'confirmation_scope_mismatch' };

/** 需要写入 confirmation scope 的输入。 */
export type ConfirmationRequest = {
  /** 当前工作流实例。 */
  runId: string;
  /** 待确认的完整 Action。 */
  action: ActionDefinition;
  /** 用户/上游确认得到的 scope hash。 */
  scopeHash: string;
  /** 确认发生时间。 */
  confirmedAt: string;
};

/** executor 只接受已通过 Policy 和幂等门禁的 Action。 */
export type ActionExecutor = (action: ActionDefinition) => ActionResult;

/** Action 执行请求，策略字段由调用方显式提供。 */
export type ExecuteRequest = PolicyRequest & {
  /** 当前工作流实例。 */
  runId: string;
  /** 实际副作用执行器。 */
  executor: ActionExecutor;
  /** executor 返回 failed 时是否允许 Workflow retry。 */
  retryable?: boolean;
};

/** 记录一次 retryable 或 permanent Workflow 错误。 */
export type FailureRequest = {
  /** 当前工作流实例。 */
  runId: string;
  /** 稳定错误分类。 */
  errorCode: string;
  /** 是否允许 retry/resume。 */
  retryable: boolean;
};

/**
 * 创建一个不可变的 WorkflowRun 快照。
 * @param run - 内部 Workflow 状态
 * @returns 深拷贝运行快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function cloneWorkflowRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}
