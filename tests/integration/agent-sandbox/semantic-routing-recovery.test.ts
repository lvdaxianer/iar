import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { flushObservabilityLogs, withObservabilityFixture } from './observability-fixture.js';

test('不完整语义帧会记录缺失字段并明确跳过路由和动作阶段', async () => {
  await withObservabilityFixture(async (fixture) => {
    const session = new IarSandboxSession({ mode: 'scripted' });
    try {
      const result = await session.turn('执行这个 200 次/秒');
      await flushObservabilityLogs();

      const records = fixture.records();
      const semantic = records.find((record) => record.event === 'iar.semantic.frame');
      const routeDecisions = records.filter((record) => record.event === 'iar.route.decision');
      const timing = result.timing?.stages ?? [];

      assert.equal(result.route.reasonCode, 'semantic_incomplete');
      assert.equal(semantic?.missingField, 'intent');
      assert.ok(routeDecisions.some((record) => record.stage === 'route.propose' && record.status === 'skipped' && record.reasonCode === 'semantic_incomplete'));
      assert.ok(routeDecisions.some((record) => record.stage === 'action.execute' && record.status === 'skipped' && record.reasonCode === 'semantic_incomplete'));
      assert.equal(timing.find((stage) => stage.stage === 'route.propose')?.status, 'skipped');
      assert.equal(timing.find((stage) => stage.stage === 'action.execute')?.status, 'skipped');
    } finally {
      session.dispose();
    }
  });
});

test('重复确认语言仍缺少目标时返回确定性澄清，不调用回复模型或执行动作', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const first = await session.turn('执行这个 200 次/秒');
    const second = await session.turn('执行这个 200 次/秒');

    for (const result of [first, second]) {
      assert.equal(result.status, 'clarification');
      assert.equal(result.route.reasonCode, 'semantic_incomplete');
      assert.match(result.reply, /目标|Function|操作/);
      assert.equal(result.timing?.stages.find((stage) => stage.stage === 'response.generate')?.status, 'skipped');
      assert.equal(result.route.functionId, undefined);
      assert.equal(result.route.pluginId, undefined);
    }
    assert.equal(first.status === 'clarification' ? first.reply : undefined, second.status === 'clarification' ? second.reply : undefined);
  } finally {
    session.dispose();
  }
});
