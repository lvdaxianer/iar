/**
 * 使用真实 sandbox 会话比较普通入口和流式入口的工作流观测。
 *
 * 这些用例只使用 scripted provider 和 sandbox handler，不访问外部模型，也不改变执行协议。
 * 参数字段的命名合并、类型和枚举校验由 parameter-collector 集成测试覆盖。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CollectionState } from '@iar/contracts';
import { IarSandboxSession, type StreamEvent, type TurnResult } from '../../../examples/agent-sandbox/src/session.js';

type SessionMode = 'normal' | 'streamed';
type TurnRequest = { session: IarSandboxSession; text: string; mode: SessionMode; events?: StreamEvent[] };

test('normal and streamed sessions preserve the same continuation route and next stage', async () => {
  const normal = new IarSandboxSession({ mode: 'scripted' });
  const streamed = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normalPending = await normal.turn('把订单接口的限流值调整到每秒50次');
    const streamedPending = await streamed.turn('把订单接口的限流值调整到每秒50次');
    assert.equal(normalPending.status, 'awaiting_confirmation');
    assert.equal(streamedPending.status, 'awaiting_confirmation');
    assert.equal((await normal.confirm(true)).status, 'executed');
    assert.equal((await streamed.confirm(true)).status, 'executed');
    const normalResult = await runTurn({ session: normal, text: '改成每秒200次吧', mode: 'normal' });
    const events: StreamEvent[] = [];
    const streamedResult = await runTurn({ session: streamed, text: '改成每秒200次吧', mode: 'streamed', events });
    assert.equal(normalResult.status, streamedResult.status);
    assert.notEqual(normalResult.status, 'pass_through');
    assert.equal(normalResult.route.functionId, 'api.gateway');
    assert.equal(normalResult.route.pluginId, 'api-gateway-v1');
    assert.deepEqual(routeIds(streamedResult), routeIds(normalResult));
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    normal.dispose();
    streamed.dispose();
  }
});

test('normal and streamed sessions fail closed for disabled or missing continuation targets', async () => {
  const targets = [
    { functionId: 'api.gateway', pluginId: 'api-gateway-v1', disabledPluginIds: ['api-gateway-v1'] },
    { functionId: 'missing.function', pluginId: 'missing-plugin', disabledPluginIds: [] }
  ] as const;
  for (const target of targets) {
    const normal = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: target.disabledPluginIds });
    const streamed = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: target.disabledPluginIds });
    try {
      await seedCollection(normal, target);
      await seedCollection(streamed, target);
      const normalResult = await runTurn({ session: normal, text: '改成每秒200次吧', mode: 'normal' });
      const streamedResult = await runTurn({ session: streamed, text: '改成每秒200次吧', mode: 'streamed' });
      for (const result of [normalResult, streamedResult]) {
        assert.equal(result.status, 'clarification');
        assert.equal(result.reasonCode, 'plugin_unavailable');
        assert.equal(result.route.functionId, target.functionId);
        assert.equal(result.route.pluginId, target.pluginId);
      }
      assert.deepEqual(routeIds(streamedResult), routeIds(normalResult));
    } finally {
      normal.dispose();
      streamed.dispose();
    }
  }
});

test('confirmation decline and topic abandonment clear old workflow state in both entry points', async () => {
  const normal = new IarSandboxSession({ mode: 'scripted' });
  const streamed = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normalPending = await normal.turn('帮我创建工单');
    const streamedPending = await streamed.turnStreamed('帮我创建工单', () => undefined);
    assert.equal(normalPending.status, 'awaiting_confirmation');
    assert.equal(streamedPending.status, 'awaiting_confirmation');
    assert.equal((await normal.confirm(false)).status, 'cancelled');
    assert.equal((await streamed.confirm(false)).status, 'cancelled');
    assert.equal((await normal.state()).pending, null);
    assert.equal((await streamed.state()).pending, null);
    const normalNewTopic = await normal.turn('算了，换个话题');
    const streamedNewTopic = await streamed.turnStreamed('算了，换个话题', () => undefined);
    assert.notEqual(normalNewTopic.status, 'executed');
    assert.notEqual(streamedNewTopic.status, 'executed');
    assert.equal((await normal.state()).context.collection, undefined);
    assert.equal((await streamed.state()).context.collection, undefined);
    assert.equal(normalNewTopic.route.functionId, undefined);
    assert.equal(streamedNewTopic.route.functionId, undefined);
  } finally {
    normal.dispose();
    streamed.dispose();
  }
});

async function runTurn(request: TurnRequest): Promise<TurnResult> {
  const events = request.events ?? [];
  return request.mode === 'normal' ? request.session.turn(request.text) : request.session.turnStreamed(request.text, (event) => events.push(event));
}

async function seedCollection(session: IarSandboxSession, target: { functionId: string; pluginId: string }): Promise<void> {
  const collection: Extract<CollectionState, { kind: 'parameters' }> = {
    kind: 'parameters', functionId: target.functionId, pluginId: target.pluginId, schemaVersion: 'iar.function/v1',
    collected: { operation: 'limit' }, missingFields: ['params'], invalidFields: [], conflictFields: [], attempt: 1,
    presentation: { params: { label: '参数', control: 'object' } }
  };
  await session.updateParameterCollection(collection);
}

function routeIds(result: TurnResult): { functionId?: string; pluginId?: string } {
  return { ...(result.route.functionId === undefined ? {} : { functionId: result.route.functionId }), ...(result.route.pluginId === undefined ? {} : { pluginId: result.route.pluginId }) };
}
