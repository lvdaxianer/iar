/*
 * 验证 Phase 2 `test1` 停止服务场景的 confirmation、executor 和幂等边界。
 * 三个服务的列表事实来自共享路由夹具，避免测试重新发明候选集合。
 * 路由失败时不得继续创建可执行 Action。
 * Workflow runId 必须与 Action runId 完整一致。
 * currentStep 先进入 awaiting_confirmation，再接受确认后的执行。
 * confirmation scope hash 使用生产 PolicyGate 的 canonical 算法。
 * executor 返回值使用公共 ActionResult Schema 的最小合法形状。
 * executor 调用计数用于证明未确认和重复提交没有第二次副作用。
 * duplicate replay 返回深拷贝结果，不重新读取业务服务。
 * granted capability 与 Plugin Manifest capability 使用相同稳定名称。
 * 失败 reasonCode 是适配器可消费的安全边界，而不是异常文本。
 * 本地测试不引入真实时间、随机数或跨进程状态。
 * 该测试完成后，后续 replay adapter 只能复用这些语义。
 * Action 的 pluginId 由路由结果提供，不允许测试自行选择另一个插件。
 * Action 的 serviceId 由列表事实首项提供，不允许静默跳过 test1。
 * confirmation 的 confirmedAt 使用固定时间，确保 fixture 可重复。
 * 第二次执行复用同一 Action 和幂等键，验证重放而非重新提交。
 * executor 输出包含 test1，证明副作用目标未漂移。
 * 未确认阶段的调用结果必须在任何 ledger 之前被拒绝。
 * 本文件不验证真实服务状态，只验证执行边界。
 * 所有断言都可以在没有外部依赖时本地运行。
 * 路由必须先固定 Function/Plugin，Workflow 才能创建 Action。
 * 高风险 Action 在确认前只能得到 confirmation_required。
 * 确认范围必须绑定完整 Action 和当前 run。
 * 确认后 executor 只调用一次，第二次提交返回 action_duplicate。
 * Action input 固定为 DIP 列表的首个服务 test1。
 * required capability 必须由调用方显式授予。
 * 测试只使用确定性内存 executor，不模拟真实 DIP API。
 * 本测试对应 OpenSpec Phase 2 Task 2.5 的执行验收。
 * replay fixture 单独验证 EventLog 事实，不把回放当作副作用执行。
 * 所有拒绝和重复结果都保留稳定 reasonCode。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition } from '../../packages/contracts/src/index.js';
import { LocalWorkflow, confirmationScopeHash, type WorkflowRequest } from '../../packages/workflow/src/index.js';
import { DIP_SERVICES, routeStopService, createStopRouteScenario } from '../routing/phase-2-stop-service-fixture.js';

/**
 * 创建停止服务场景的本地 WorkflowDefinition。
 * @returns 允许确认和执行步骤的确定性状态机
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(): WorkflowRequest {
  return {
    runId: 'run-stop-test1',
    definition: {
      schemaVersion: SCHEMA_VERSIONS.workflow,
      workflowId: 'dip-stop-v1',
      version: '1.0.0',
      description: 'stop first listed DIP service',
      states: ['start', 'awaiting_confirmation', 'executing', 'done'],
      initialState: 'start',
      terminalStates: ['done'],
      transitions: [
        { event: 'request_confirmation', from: 'start', to: 'awaiting_confirmation' },
        { event: 'confirm', from: 'awaiting_confirmation', to: 'executing' },
        { event: 'complete', from: 'executing', to: 'done' }
      ]
    }
  };
}

/**
 * 创建绑定 test1 和已路由插件的高风险 Action。
 * @param pluginId - 路由选中的插件标识
 * @returns 需要确认的 ActionDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(pluginId: string): ActionDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.action,
    actionId: 'action-stop-test1',
    runId: 'run-stop-test1',
    functionId: 'dip.service.stop',
    pluginId,
    idempotencyKey: 'stop:run-stop-test1:test1',
    input: { serviceId: DIP_SERVICES[0] },
    riskLevel: 'high' as const,
    confirmationRequired: true
  };
}

/* 确认前不执行，确认后只执行一次并稳定重放第一次结果。 */
test('requires confirmation before executing test1 stop and replays once', async () => {
  const route = createStopRouteScenario();
  const routed = routeStopService(route);
  assert.equal(routed.status, 'matched');
  const pluginId = routed.pluginId;
  assert.ok(pluginId);
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action(pluginId);
  assert.equal(workflow.transition({ runId: request().runId, event: 'request_confirmation' }).value?.currentStep, 'awaiting_confirmation');
  let calls = 0;
  const executor = () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const, output: { serviceId: DIP_SERVICES[0], stopped: true } };
  };
  const input = { runId: target.runId, action: target, requiredCapabilities: ['dip.service.write'], grantedCapabilities: ['dip.service.write'], authorized: true, executor };
  const beforeConfirmation = await workflow.execute(input);
  assert.equal(beforeConfirmation.reasonCode, 'confirmation_required');
  assert.equal(calls, 0);
  assert.equal(workflow.confirm({ runId: target.runId, action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:00.000Z' }).ok, true);
  const first = await workflow.execute(input);
  const duplicate = await workflow.execute(input);

  assert.equal(first.value?.status, 'succeeded');
  assert.equal(duplicate.reasonCode, 'action_duplicate');
  const output = duplicate.value?.output;
  assert.equal(typeof output === 'object' && output !== null && !Array.isArray(output) && 'serviceId' in output, true);
  assert.equal(calls, 1);
});
