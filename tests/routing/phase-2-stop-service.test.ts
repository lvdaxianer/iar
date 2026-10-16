/*
 * 验证 Phase 2 `test1` 停止服务场景的 Function-first 两阶段路由。
 * 三个 DIP 服务作为有限事实输入，首个服务必须保持为 test1。
 * Function provider 先选择 dip.service.stop，Plugin provider 才能看到插件候选。
 * Plugin 选择必须来自已启用、已授权并满足能力的宿主记录。
 * 本测试不执行 Action，执行语义由对应 Workflow 测试固定。
 * provider 输出仅是受限 choice，不是授权或 executor 输入。
 * 路由结果保留两阶段决策证据，供 replay fixture 复用。
 * 测试不依赖真实模型、网络、数据库或外部服务。
 * 该场景对应 OpenSpec Phase 2 Task 2.5 的路由验收。
 * 修改路由顺序时必须保持 Function before Plugin 断言。
 * 修改候选边界时必须保持首个服务和插件选择断言。
 * 本文件只验证候选与决策，不验证确认和幂等副作用。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DIP_SERVICES, createStopRouteScenario, routeStopService } from './phase-2-stop-service-fixture.js';

/* 首个 DIP 服务必须恢复为 test1，并完成 Function → Plugin 两阶段选择。 */
test('routes the first listed DIP service through Function then authorized Plugin', () => {
  const scenario = createStopRouteScenario();
  const result = routeStopService(scenario);

  assert.deepEqual(scenario.request.facts.services, DIP_SERVICES.map((id) => ({ id, type: 'dip.service' })));
  assert.equal(result.status, 'matched');
  assert.equal(result.functionId, 'dip.service.stop');
  assert.equal(result.pluginId, 'dip-api-stop-v1');
  assert.equal(scenario.functionCalls[0]?.decisionType, 'function.select');
  assert.equal(scenario.pluginCalls[0]?.decisionType, 'plugin.select');
  assert.deepEqual(scenario.pluginCalls[0]?.candidates.map((candidate) => candidate.candidateId), ['dip-api-stop-v1']);
});
