/**
 * 定义 durable workflow adapter 的版本化公共类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ActionResult, EventEnvelope } from '@iar/contracts';
import type { ConfirmationRequest, ExecuteRequest, FailureRequest, WorkflowRequest, WorkflowResult, WorkflowRun } from '@iar/workflow';

/** 触发 durable execution 的受支持长期运行原因。 */
export type DurableRequirementReason = 'timer' | 'cross_service' | 'compensation';

/** 描述一个 Workflow 为什么需要 durable execution。 */
export type DurableWorkflowRequirement = {
  /** 需要 durable 执行的 Workflow 定义标识。 */
  workflowId: string;
  /** 至少包含一个明确的长期运行原因。 */
  reasons: readonly DurableRequirementReason[];
  /** 供审批和审计使用的业务理由。 */
  rationale?: string;
};

/** 长流程准入判定结果。 */
export type DurableAdmissionDecision =
  | { admitted: true; workflowId: string; reasons: readonly DurableRequirementReason[] }
  | { admitted: false; reasonCode: 'durable_requirement_missing' | 'durable_requirement_invalid' };

/** durable WorkflowRuntime 的稳定 v1 合约。 */
export type WorkflowRuntimeContract = {
  /** 适配器名称，供审计和运行时选择使用。 */
  readonly adapterName: string;
  /** 适配器契约版本，当前只允许 v1。 */
  readonly adapterVersion: 'v1';
  /** 启动一个已通过输入校验的 Workflow 请求。 */
  start(request: WorkflowRequest): WorkflowResult<WorkflowRun> | Promise<WorkflowResult<WorkflowRun>>;
};

/** 创建 durable WorkflowRuntime 所需的固定配置。 */
export type WorkflowRuntimeOptions = {
  /** 适配器名称，不能为空。 */
  adapterName: string;
  /** 适配器契约版本。 */
  adapterVersion: 'v1';
};

/** Durable step 的状态，pending 代表副作用尚未收敛。 */
export type DurableStepStatus = 'pending' | 'completed';

/** Durable step 的有限操作类型。 */
export type DurableStepOperation = 'start' | 'transition' | 'confirm' | 'execute' | 'fail' | 'retry' | 'timeout' | 'cancel' | 'resume';

/** 不包含 executor 函数的可持久化 Action 请求。 */
export type DurableExecuteRequest = Omit<ExecuteRequest, 'executor'> & { stepId: string };

/** 供恢复重放的显式 step 输入。 */
export type DurableStepData =
  /** Workflow 创建事实。 */
  | { kind: 'start' }
  /** 状态机事件输入。 */
  | { kind: 'transition'; event: string }
  /** 脱敏后的 confirmation 输入。 */
  | { kind: 'confirm'; input: ConfirmationRequest }
  /** 不包含 executor 的 Action 输入。 */
  | { kind: 'execute'; request: DurableExecuteRequest }
  /** 可恢复失败输入。 */
  | { kind: 'fail'; input: FailureRequest }
  /** retry 操作输入。 */
  | { kind: 'retry'; runId: string }
  /** timeout 操作输入。 */
  | { kind: 'timeout'; runId: string }
  /** cancel 操作输入。 */
  | { kind: 'cancel'; runId: string }
  /** resume 操作输入。 */
  | { kind: 'resume'; runId: string };

/** 一个已持久化的 Workflow step。 */
export type DurableStepRecord = {
  /** step 的稳定标识。 */
  stepId: string;
  /** 持久顺序，用于 worker 恢复。 */
  sequence: number;
  /** step 操作类型。 */
  operation: DurableStepOperation;
  /** pending 或已完成状态。 */
  status: DurableStepStatus;
  /** 恢复所需的安全输入。 */
  data: DurableStepData;
};

/** 一个 Action 的 pending 或最终结果记录。 */
export type DurableActionRecord = {
  /** 脱敏后的 Action 请求。 */
  request: DurableExecuteRequest;
  /** 原始 Action 身份的稳定摘要。 */
  actionDigest: string;
  /** Action 是否已收敛。 */
  status: 'pending' | 'completed';
  /** 脱敏后的 Action 结果。 */
  outcome?: WorkflowResult<ActionResult>;
};

/** 可跨 worker 保存和读取的 Workflow 快照。 */
export type DurableWorkflowSnapshot = {
  /** CAS 版本号。 */
  version: number;
  /** 当前 Workflow 运行态。 */
  run: WorkflowRun;
  /** 有序持久步骤。 */
  steps: DurableStepRecord[];
  /** 幂等 Action 记录。 */
  actions: DurableActionRecord[];
  /** 脱敏后的 IAR 事实事件。 */
  events: EventEnvelope[];
  /** 下一个 durable event 序号。 */
  nextEventSequence: number;
};

/** DurableWorkflowRuntime 使用的持久化边界。 */
export interface DurableWorkflowStore {
  /** 读取一个 Workflow 的最新快照。 */
  load(runId: string): Promise<DurableWorkflowSnapshot | undefined>;
  /** 原子创建一个尚不存在的 Workflow 快照。 */
  create(snapshot: DurableWorkflowSnapshot): Promise<boolean>;
  /** 按 expectedVersion 原子更新一个 Workflow 快照。 */
  save(snapshot: DurableWorkflowSnapshot, expectedVersion: number): Promise<void>;
}

/** Durable runtime 的固定准入配置和可选 store。 */
export type DurableWorkflowRuntimeOptions = WorkflowRuntimeOptions & {
  requirement: DurableWorkflowRequirement;
  store?: DurableWorkflowStore;
};
