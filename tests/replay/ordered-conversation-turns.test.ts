/**
 * 验证会话轮次与可信事实历史分离，并能兼容旧 BehaviorContext 快照。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateContract, type BehaviorContext, type EventEnvelope } from '@iar/contracts';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from '@iar/runtime';

test('初始上下文包含独立的空会话轮次历史', () => {
  const context = createInitialContext('run-turns');

  assert.deepEqual(context.conversationTurns, { turns: [] });
  assert.equal(validateContract('behaviorContext', context).ok, true);
});

test('会话轮次按 sequence 保存且不改变事实历史', () => {
  const base = createInitialContext('run-turns');
  const context: BehaviorContext = {
    ...base,
    conversationTurns: {
      turns: [{
        turnId: 'turn-001',
        sequence: 1,
        userText: '请查询工单',
        assistantText: '当前没有可确认的工单。',
        outcome: 'completed',
        actionTaken: false,
        completedAt: '2026-10-24T00:00:00.000Z'
      }],
      focusTurnId: 'turn-001'
    },
    factHistory: { records: [] }
  };

  assert.equal(validateContract('behaviorContext', context).ok, true);
  assert.equal(criticalFieldHash(context) !== criticalFieldHash(base), true);
  assert.equal(context.factHistory?.records.length, 0);
});

test('会话轮次拒绝重复 ID、乱序 sequence 和错误焦点', () => {
  const base = createInitialContext('run-turn-validation');
  const turn = {
    turnId: 'turn-001',
    sequence: 1,
    userText: '问题',
    assistantText: '回答',
    outcome: 'completed' as const,
    actionTaken: false,
    completedAt: '2026-10-24T00:00:00.000Z'
  };
  const invalid = {
    ...base,
    conversationTurns: {
      turns: [turn, { ...turn, sequence: 0 }, { ...turn, sequence: 2 }],
      focusTurnId: 'turn-missing'
    }
  };

  assert.equal(validateContract('behaviorContext', invalid).ok, false);
});

test('旧快照没有会话轮次字段时仍可读取并归一化为空历史', () => {
  const initial = createInitialContext('run-legacy-turns');
  const { conversationTurns: _ignoredTurns, ...legacy } = initial;
  legacy.schemaVersion = SCHEMA_VERSIONS.behaviorContext;
  legacy.integrity.criticalFieldHash = criticalFieldHash(legacy);

  const restored = new BehaviorContextProjector(legacy).current();

  assert.deepEqual(restored.conversationTurns, { turns: [] });
});

test('会话轮次完成事件只接受完整的轮次载荷', () => {
  const event: EventEnvelope = {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId: 'event-turn-001',
    eventName: 'conversation.turn.completed',
    occurredAt: '2026-10-24T00:00:00.000Z',
    runId: 'run-turn-event',
    correlationId: 'corr-turn-event',
    payload: {
      turn: {
        turnId: 'turn-001',
        sequence: 1,
        userText: '问题',
        assistantText: '回答',
        outcome: 'completed',
        actionTaken: false,
        completedAt: '2026-10-24T00:00:00.000Z'
      }
    }
  };

  assert.equal(validateContract('event', event).ok, true);
  assert.equal(validateContract('event', { ...event, payload: { turn: { sequence: 1 } } }).ok, false);
});
