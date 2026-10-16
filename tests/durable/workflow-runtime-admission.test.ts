/**
 * 验证长流程准入门槛和 WorkflowRuntime 合约的无副作用边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type WorkflowDefinition } from '../../packages/contracts/src/index.js';
import { ContractWorkflowRuntime, evaluateDurableAdmission, type DurableWorkflowRequirement } from '../../packages/adapters/temporal/src/index.js';
import type { WorkflowRequest } from '../../packages/workflow/src/index.js';

/**
 * 创建用于准入测试的最小合法 WorkflowDefinition。
 *
 * @returns 版本化本地 Workflow 定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function workflowDefinition(): WorkflowDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.workflow,
    workflowId: 'durable-flow',
    version: '1.0.0',
    description: 'durable admission fixture',
    states: ['start', 'done'],
    initialState: 'start',
    terminalStates: ['done'],
    transitions: [{ event: 'finish', from: 'start', to: 'done' }]
  };
}

/**
 * 创建稳定的 durable WorkflowRequest。
 *
 * @param runId - 工作流运行实例标识
 * @returns 可交给 WorkflowRuntime contract 的请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function durableRequest(runId: string): WorkflowRequest {
  return { runId, definition: workflowDefinition() };
}

test('短动作默认保持本地运行时并拒绝 durable adapter', () => {
  const requirement: DurableWorkflowRequirement = { workflowId: 'short-flow', reasons: [] };
  const decision = evaluateDurableAdmission(requirement);
  assert.deepEqual(decision, { admitted: false, reasonCode: 'durable_requirement_missing' });
});

test('timer、cross-service 和 compensation 任一明确需求可准入 durable adapter', () => {
  const reasons = ['timer', 'cross_service', 'compensation'] as const;
  const decisions = reasons.map((reason) => evaluateDurableAdmission({ workflowId: 'long-flow', reasons: [reason] }));
  assert.deepEqual(decisions.map((decision) => decision.admitted), [true, true, true]);
});

test('WorkflowRuntime contract 要求显式 runtime selection 和稳定 workflow identity', () => {
  const request = durableRequest('durable-flow');
  const runtime = new ContractWorkflowRuntime({ adapterName: 'temporal-compatible', adapterVersion: 'v1' });
  assert.deepEqual(runtime.start(request), { ok: false, reasonCode: 'durable_adapter_not_implemented' });
});

test('WorkflowRuntime 拒绝空名称和非 v1 adapter 配置', () => {
  assert.throws(
    () => new ContractWorkflowRuntime({ adapterName: '', adapterVersion: 'v2' } as never),
    new Error('durable_adapter_configuration_invalid')
  );
});

test('缺少 timer、cross-service、compensation 之外的理由不能绕过准入门槛', () => {
  const requirement = { workflowId: 'invalid-flow', reasons: ['queue'] } as unknown as DurableWorkflowRequirement;
  assert.deepEqual(evaluateDurableAdmission(requirement), { admitted: false, reasonCode: 'durable_requirement_invalid' });
});

test('rationale 类型无效时拒绝 durable 准入', () => {
  const requirement = { workflowId: 'invalid-rationale', reasons: ['timer'], rationale: 42 } as unknown as DurableWorkflowRequirement;
  assert.deepEqual(evaluateDurableAdmission(requirement), { admitted: false, reasonCode: 'durable_requirement_invalid' });
});

test('恶意 getter 不得从准入入口抛出原始异常', () => {
  const requirement = { workflowId: 'malicious-flow', get reasons(): never { throw new Error('secret'); } };
  assert.deepEqual(evaluateDurableAdmission(requirement), { admitted: false, reasonCode: 'durable_requirement_invalid' });
});
