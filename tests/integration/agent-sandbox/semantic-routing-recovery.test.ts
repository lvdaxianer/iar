import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { flushObservabilityLogs, withObservabilityFixture } from './observability-fixture.js';

test('无法解析历史指代时交给回复模型澄清并明确跳过业务路由', async () => {
  await withObservabilityFixture(async (fixture) => {
    const session = new IarSandboxSession({ mode: 'scripted' });
    try {
      const result = await session.turn('请处理这个请求');
      await flushObservabilityLogs();

      const records = fixture.records();
      const semantic = records.find((record) => record.event === 'iar.semantic.frame');
      const routeDecisions = records.filter((record) => record.event === 'iar.route.decision');
      const timing = result.timing?.stages ?? [];

      assert.equal(result.route.reasonCode, 'reference_unresolved');
      assert.equal(semantic?.missingField, 'intent');
      assert.equal(routeDecisions.length, 0);
      assert.equal(timing.find((stage) => stage.stage === 'route.propose'), undefined);
      assert.equal(timing.find((stage) => stage.stage === 'action.execute'), undefined);
      assert.equal(timing.find((stage) => stage.stage === 'response.generate')?.status, 'completed');
    } finally {
      session.dispose();
    }
  });
});

test('重复确认语言仍缺少目标时返回安全澄清且不执行动作', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const first = await session.turn('请处理这个请求');
    const second = await session.turn('请处理这个请求');

    for (const result of [first, second]) {
      assert.equal(result.status, 'clarification');
      assert.equal(result.route.reasonCode, 'reference_unresolved');
      assert.match(result.reply, /对象|目标|Function|操作/);
      assert.equal(result.timing?.stages.find((stage) => stage.stage === 'response.generate')?.status, 'completed');
      assert.equal(result.route.functionId, undefined);
      assert.equal(result.route.pluginId, undefined);
    }
    assert.equal(first.status === 'clarification' ? first.reply : undefined, second.status === 'clarification' ? second.reply : undefined);
  } finally {
    session.dispose();
  }
});

test('完整路由和候选为空分别记录 route matched 与 candidate empty', async () => {
  await withObservabilityFixture(async (fixture) => {
    const matchedSession = new IarSandboxSession({ mode: 'scripted' });
    try {
      const matched = await matchedSession.turn('现在有哪些告警');
      assert.equal(matched.status, 'executed');
      await flushObservabilityLogs();
      const matchedRoutes = fixture.records().filter((record) => record.event === 'iar.route.decision');
      assert.ok(matchedRoutes.some((record) => record.stage === 'route.select' && record.status === 'completed' && record.reasonCode === 'route_matched'));
      assert.ok(matchedRoutes.some((record) => record.stage === 'action.execute' && record.status === 'completed' && record.execution === 'allowed'));
    } finally {
      matchedSession.dispose();
    }

    const emptySession = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: ['system-status-v1'] });
    try {
      const empty = await emptySession.turn('现在有哪些告警');
      assert.notEqual(empty.status, 'executed');
      await flushObservabilityLogs();
      const emptyRoutes = fixture.records().filter((record) => record.event === 'iar.route.decision');
      assert.ok(emptyRoutes.some((record) => record.stage === 'route.select' && record.status === 'failed' && record.reasonCode === 'candidate_empty' && record.execution === 'blocked'));
    } finally {
      emptySession.dispose();
    }
  });
});
