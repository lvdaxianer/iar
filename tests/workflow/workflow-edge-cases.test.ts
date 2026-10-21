/*
 * 覆盖 Task 2.4 的运行时边界回归场景。
 * 幂等键必须绑定完整 Action 身份和输入。
 * malformed 状态 mutation 不能抛异常或污染内部状态。
 * ledger 预占后的 cancel 竞态必须补偿为稳定失败结果。
 * 竞态后不得调用 executor，也不能留下不可解释的 in-progress。
 * 这些场景与主 workflow 测试分离，保持每个测试文件小于 350 行。
 * 测试只使用内存 workflow、fake ledger 和确定性 Action。
 * 不访问真实数据库、插件、模型或网络。
 * 失败结果的 reasonCode 是后续 replay 的稳定输入。
 * 这里不验证业务 Action 的实际副作用逻辑。
 * 任何 adapter 都必须保留这些幂等和竞态语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type WorkflowDefinition } from '@iar/contracts';
import { LocalWorkflow } from '@iar/runtime';
import type { ActionIdempotencyLedger } from '@iar/runtime';
import type { WorkflowRequest } from '@iar/runtime';

/**
 * 创建 edge case 使用的确定性 WorkflowDefinition。
 * @returns 合法本地状态机定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.workflow, workflowId: 'local-action', version: '1.0.0', description: 'local deterministic action workflow', states: ['start', 'done'], initialState: 'start', terminalStates: ['done'], transitions: [{ event: 'finish', from: 'start', to: 'done' }] };
}

/**
 * 创建 edge case 使用的低风险 Action。
 * @param overrides - 场景需要覆盖的 Action 字段
 * @returns 合法 ActionDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId: 'action-1', runId: 'run-1', functionId: 'dip.service.stop', pluginId: 'dip-api-stop-v1', idempotencyKey: 'idem-1', input: { serviceId: 'test1' }, riskLevel: 'low', confirmationRequired: false, ...overrides };
}

/**
 * 创建 edge case 的启动请求。
 * @returns 合法 WorkflowRequest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(): WorkflowRequest {
  return { runId: 'run-1', definition: definition() };
}

/*
 * edge case 测试专门验证不常见但高风险的状态窗口。
 * Action identity 比较覆盖 runId、pluginId、functionId 和 input。
 * 相同 idempotencyKey 不代表相同 Action。
 * malformed transition 不能调用 Map 或状态机。
 * malformed failure 不能写入任意 errorCode/retryable。
 * fake ledger 在 await 边界内触发 cancel，模拟真实竞态。
 * 状态变化后 executor 必须保持零调用。
 * 竞态补偿结果必须可重复读取。
 * 这些测试不依赖真实时间或随机值。
 * 这些测试与主 workflow 文件共享相同的 Action Schema。
 * edge case 结果仍然使用稳定 reasonCode。
 * 未来 adapter 不得删除这些拒绝路径。
 * 任何重复副作用都必须由幂等键阻断。
 * 任何状态竞态都必须 fail-closed。
 * 本文件只补充主测试未覆盖的边界。
 * 取消和超时错误码必须保留，供审计与后续 adapter 解释终态原因。
 * 这些测试覆盖 ledger await 前后两个状态观察点。
 * Action identity 不仅由 idempotencyKey 单字段决定。
 * confirmation scope hash 用于稳定比较完整 Action 身份。
 * Policy 失败不得改变 ledger 或 ActionResult 状态。
 * executor 失败结果仍需要可重放的稳定错误码。
 * 非法 executor 结果不能被误判为业务成功。
 * 状态机 malformed 输入不得抛出未捕获异常。
 * 每个竞态测试都断言 executor 调用次数为零或一。
 * timeout 与 cancel 都是终态，但保留不同审计原因。
 * 新增 adapter 时应复用这些本地边界语义。
 */
/* idempotencyKey 不能跨 Action 身份复用，否则第一次结果不能安全重放。 */
test('idempotency key conflict rejects a different Action identity', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const firstAction = action();
  const secondAction = action({ actionId: 'action-2' });
  const executor = () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: 'action-1', status: 'succeeded' as const });
  await workflow.execute({ runId: 'run-1', action: firstAction, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });
  const result = await workflow.execute({ runId: 'run-1', action: secondAction, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });

  assert.equal(result.reasonCode, 'idempotency_key_conflict');
});

/* malformed transition/failure 输入必须返回稳定错误而不是抛异常或污染状态。 */
test('runtime state mutation inputs fail closed', () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  assert.equal(workflow.transition(null as unknown as { runId: string; event: string }).reasonCode, 'workflow_input_invalid');
  assert.equal(workflow.fail({ runId: 'run-1', errorCode: 42 as unknown as string, retryable: 'yes' as unknown as boolean }).reasonCode, 'workflow_input_invalid');
});

/* ledger 写入后的 cancel 竞态必须补偿为失败结果，不能留下永久 in-progress。 */
test('state race after idempotency reservation is compensated', async () => {
  const target = action();
  let workflow!: LocalWorkflow;
  const ledger = { start: async () => { workflow.cancel('run-1'); return { ok: true as const, value: target }; } } as unknown as ActionIdempotencyLedger;
  workflow = new LocalWorkflow({ ledger });
  workflow.start(request());
  let calls = 0;
  const result = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => { calls += 1; return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }; } });

  assert.equal(result.reasonCode, 'workflow_state_changed');
  assert.equal(calls, 0);
  assert.equal(workflow.get('run-1').value?.lastError?.code, 'workflow.cancelled');
  const duplicate = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) });
  assert.equal(duplicate.reasonCode, 'action_duplicate');
});

/* timeout 竞态也必须保留原始终态错误码，同时阻断 executor。 */
test('timeout state race preserves the terminal error', async () => {
  const target = action({ idempotencyKey: 'idem-timeout' });
  let workflow!: LocalWorkflow;
  const ledger = { start: async () => { workflow.timeout('run-1'); return { ok: true as const, value: target }; } } as unknown as ActionIdempotencyLedger;
  workflow = new LocalWorkflow({ ledger });
  workflow.start(request());
  let calls = 0;
  const result = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => { calls += 1; return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }; } });

  assert.equal(result.reasonCode, 'workflow_state_changed');
  assert.equal(calls, 0);
  assert.equal(workflow.get('run-1').value?.lastError?.code, 'workflow.timeout');
});

/* Policy 失败必须先于 duplicate replay，防止已完成结果绕过授权。 */
test('duplicate replay still requires current policy approval', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action();
  const execute = { runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) };
  await workflow.execute(execute);
  const unauthorized = await workflow.execute({ ...execute, authorized: false });
  const duplicate = await workflow.execute(execute);

  assert.equal(unauthorized.reasonCode, 'policy_unauthorized');
  assert.equal(duplicate.reasonCode, 'action_duplicate');
});

/* 非法 executor/retryable 必须在 ledger 之前拒绝，不能消耗幂等键。 */
test('malformed executor input does not reserve the idempotency key', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action();
  const malformed = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: null as unknown as () => never, retryable: 'yes' as unknown as boolean });
  const valid = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) });

  assert.equal(malformed.reasonCode, 'workflow_input_invalid');
  assert.equal(valid.ok, true);
});

/* executor 的非法 Schema 或 actionId 必须被转换为稳定失败。 */
test('malformed executor result is rejected before success', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const invalidSchema = await workflow.execute({ runId: 'run-1', action: action(), requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({}) as never });
  const secondWorkflow = new LocalWorkflow();
  secondWorkflow.start(request());
  const invalidActionId = await secondWorkflow.execute({ runId: 'run-1', action: action({ idempotencyKey: 'idem-2' }), requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: 'other', status: 'succeeded' as const }) });

  assert.equal(invalidSchema.reasonCode, 'action_result_invalid');
  assert.equal(invalidActionId.reasonCode, 'action_result_invalid');
});
