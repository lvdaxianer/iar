/**
 * 验证会话轮次完成事件的生成、投影、顺序和会话边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CONVERSATION_TURNS, SCHEMA_VERSIONS, type ConversationTurn, type EventEnvelope } from '@iar/contracts';
import { BehaviorContextProjector, WorkflowEventLog, createInitialContext, replayEvents } from '@iar/runtime';

/** 创建一个可重复使用的完整会话轮次。 */
function turn(turnId = 'turn-001', sequence = 1): ConversationTurn {
  return {
    turnId,
    sequence,
    userText: '请查询当前工单',
    assistantText: '当前没有可确认的工单。',
    outcome: 'completed',
    actionTaken: false,
    completedAt: '2026-10-24T00:00:00.000Z'
  };
}

/** 创建带指定运行 ID 的轮次完成事件。 */
function event(runId: string, item: ConversationTurn): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId: `${runId}-${item.turnId}`,
    eventName: 'conversation.turn.completed',
    occurredAt: item.completedAt,
    runId,
    correlationId: `${runId}-correlation`,
    payload: { turn: item }
  };
}

test('完成轮次事件写入并投影为独立的有序会话历史', () => {
  const log = new WorkflowEventLog({ clock: () => '2026-10-24T00:00:00.000Z', eventIdPrefix: 'turn-event' });
  log.conversationTurnCompleted('run-turns', turn());
  const [completed] = log.events;
  assert.ok(completed);
  assert.equal(completed.eventName, 'conversation.turn.completed');

  const projector = new BehaviorContextProjector(createInitialContext('run-turns'), 'run-turns');
  projector.apply(completed);
  const context = projector.current();
  assert.deepEqual(context.conversationTurns?.turns.map((item) => item.turnId), ['turn-001']);
  assert.equal(context.conversationTurns?.focusTurnId, 'turn-001');
  assert.deepEqual(replayEvents([completed]).conversationTurns, context.conversationTurns);
});
test('重复完成事件按 turnId 幂等，旧序号或不同运行会被拒绝', () => {
  const projector = new BehaviorContextProjector(createInitialContext('run-turns'), 'run-turns');
  const first = event('run-turns', turn());
  projector.apply(first);
  projector.apply(first);

  assert.throws(() => projector.apply(event('run-turns', turn('turn-002', 1))), /顺序|sequence|轮次/);
  assert.throws(() => projector.apply(event('other-run', turn('turn-003', 2))), /run|会话/);
  assert.deepEqual(projector.current().conversationTurns?.turns.map((item) => item.turnId), ['turn-001']);
});

test('会话轮次窗口只保留最新的有界记录', () => {
  const projector = new BehaviorContextProjector(createInitialContext('run-bounded'), 'run-bounded');
  for (let sequence = 1; sequence <= MAX_CONVERSATION_TURNS + 1; sequence += 1) {
    projector.apply(event('run-bounded', turn(`turn-${sequence}`, sequence)));
  }

  const turns = projector.current().conversationTurns?.turns ?? [];
  assert.equal(turns.length, MAX_CONVERSATION_TURNS);
  assert.equal(turns[0]?.sequence, 2);
  assert.equal(turns.at(-1)?.sequence, MAX_CONVERSATION_TURNS + 1);
});
