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
