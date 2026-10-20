/**
 * 验证可信事实以有序记录追加，而不是按动态字段覆盖。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateContract, type EventEnvelope } from '@iar/contracts';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from '@iar/runtime';

/** 创建成功动作事件，使用测试中的动态能力标识。 */
function completedEvent(eventId: string, value: string): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId,
    eventName: 'action.completed',
    occurredAt: '2026-10-20T00:00:00.000Z',
    runId: 'run-ordered-facts',
    correlationId: 'corr-ordered-facts',
    payload: {
      functionId: 'capability.alpha',
      pluginId: 'provider.alpha-v1',
      resultStatus: 'succeeded',
      output: { facts: { resultKey: value } }
    }
  };
}

test('相同动态字段的连续成功结果保留为有序事实记录', () => {
  const projector = new BehaviorContextProjector();
  projector.apply(completedEvent('event-first', 'first-value'));
  projector.apply(completedEvent('event-second', 'second-value'));

  const context = projector.current() as unknown as {
    factHistory?: { records: Array<{ recordId: string; sequence: number; sourceEventId: string; values: Record<string, unknown> }>; focusRecordId?: string };
  };
  assert.deepEqual(context.factHistory?.records.map((record) => record.values.resultKey), ['first-value', 'second-value']);
  assert.deepEqual(context.factHistory?.records.map((record) => record.sourceEventId), ['event-first', 'event-second']);
  assert.notEqual(context.factHistory?.records[0]?.recordId, context.factHistory?.records[1]?.recordId);
  assert.deepEqual(context.factHistory?.records.map((record) => record.sequence), [1, 2]);
  assert.equal(context.factHistory?.focusRecordId, context.factHistory?.records[1]?.recordId);
});

test('相同成功事件重复投影不会重复追加事实记录', () => {
  const projector = new BehaviorContextProjector();
  const event = completedEvent('event-idempotent', 'stable-value');
  projector.apply(event);
  projector.apply(event);

  const context = projector.current() as unknown as {
    factHistory?: { records: Array<{ sourceEventId: string }> };
  };
  assert.deepEqual(context.factHistory?.records.map((record) => record.sourceEventId), ['event-idempotent']);
});

test('事实链焦点必须指向已有记录且序号保持升序', () => {
  const base = createInitialContext('run-schema');
  const valid = {
    ...base,
    factHistory: {
      records: [{
        recordId: 'fact-one', sequence: 1, sourceEventId: 'event-one', functionId: 'capability.alpha', pluginId: 'provider.alpha-v1',
        values: { resultKey: 'value-one' }, createdAt: '2026-10-20T00:00:00.000Z'
      }],
      focusRecordId: 'fact-one'
    }
  };
  assert.equal(validateContract('behaviorContext', valid).ok, true);
  assert.equal(validateContract('behaviorContext', { ...valid, factHistory: { ...valid.factHistory, focusRecordId: 'fact-missing' } }).ok, false);
  assert.equal(validateContract('behaviorContext', {
    ...valid,
    factHistory: { records: [{ ...valid.factHistory.records[0], sequence: 2 }, { ...valid.factHistory.records[0], recordId: 'fact-two', sequence: 1 }] }
  }).ok, false);
});

test('旧 facts 快照进入投影器后归一化为事实记录', () => {
  const base = createInitialContext('run-legacy');
  const { factHistory: _ignoredFactHistory, ...legacyBase } = base;
  const legacy = { ...legacyBase, facts: {
    'legacy.key': { value: 'legacy-value', status: 'verified' as const, sourceEventId: 'event-legacy', functionId: 'capability.legacy', pluginId: 'provider.legacy-v1', field: 'key' }
  } };
  legacy.integrity.criticalFieldHash = criticalFieldHash(legacy);
  const context = new BehaviorContextProjector(legacy).current() as unknown as { factHistory?: { records: Array<{ values: Record<string, unknown> }> } };
  assert.deepEqual(context.factHistory?.records[0]?.values, { key: 'legacy-value' });
});
