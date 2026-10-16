/**
 * 定义 durable workflow adapter 的版本化公共类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { WorkflowRequest, WorkflowResult, WorkflowRun } from '@iar/workflow';

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
  start(request: WorkflowRequest): WorkflowResult<WorkflowRun>;
};

/** 创建 durable WorkflowRuntime 所需的固定配置。 */
export type WorkflowRuntimeOptions = {
  /** 适配器名称，不能为空。 */
  adapterName: string;
  /** 适配器契约版本。 */
  adapterVersion: 'v1';
};
