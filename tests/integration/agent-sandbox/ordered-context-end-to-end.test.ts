/** 验证有序轮次、可信事实和重启恢复在真实会话入口中保持独立顺序。
 * 测试不依赖自然语言关键词解析历史引用，而是用模型协议中的 scope、sequence 和 id 验证运行时边界。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BehaviorContext, EventEnvelope } from '@iar/contracts';
import type { PersistenceProviderManifest, RecentMessageQuery, SessionIdentity, SessionListPage, SessionListQuery, SessionMessage, SessionPersistenceProvider, SessionSnapshotRecord } from '@iar/storage';
import type { SemanticFrame } from '@iar/runtime';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

const manifest: PersistenceProviderManifest = {
  providerId: 'ordered-context-e2e-provider',
  apiVersion: 'iar.persistence/v1',
  capabilities: ['messages', 'events', 'snapshots', 'async']
};

/** 仅保存公开 SPI 数据的内存 Provider，用于验证重启后的事件恢复。 */
class MemoryPersistenceProvider implements SessionPersistenceProvider {
  public readonly manifest = manifest;
  public readonly messages: SessionMessage[] = [];
  public readonly events: EventEnvelope[] = [];
  public readonly snapshots: SessionSnapshotRecord[] = [];

  public async open(): Promise<void> {}
  public async appendMessage(_identity: SessionIdentity, message: SessionMessage): Promise<void> { this.messages.push(structuredClone(message)); }
  public async appendEvent(_identity: SessionIdentity, event: EventEnvelope): Promise<void> { this.events.push(structuredClone(event)); }
  public async saveSnapshot(_identity: SessionIdentity, snapshot: SessionSnapshotRecord): Promise<void> { this.snapshots.push(structuredClone(snapshot)); }
  public async loadSnapshot(): Promise<SessionSnapshotRecord | undefined> { return structuredClone(this.snapshots.at(-1)); }
  public async listEvents(): Promise<EventEnvelope[]> { return structuredClone(this.events); }
  public async listMessages(_sessionId: string, _query?: RecentMessageQuery): Promise<SessionMessage[]> { return structuredClone(this.messages); }
  public async listSessions(_query?: SessionListQuery): Promise<SessionListPage> { return { sessions: [] }; }
  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

type RoutingAccess = {
  resolveReferences: (frame: SemanticFrame, context: BehaviorContext) =>
    | { ok: true; references: Array<{ text: string; turn?: { turnId: string; sequence: number; userText: string }; record?: { recordId: string; sequence: number; values: Record<string, unknown> } }> }
    | { ok: false; reasonCode: string };
};

/** 读取公开会话之外的引用解析器，仅用于验证 Runtime 的内部安全边界。 */
function routingOf(session: IarSandboxSession): RoutingAccess {
  return (session as unknown as { routing: RoutingAccess }).routing;
}

/** 构造只表达上下文作用域与有序目标的 SemanticFrame。 */
function referenceFrame(reference: SemanticFrame['references'][number]): SemanticFrame {
  return {
    schemaVersion: 'iar.semantic-frame/v2',
    intent: 'unknown',
    action: 'query',
    slots: {},
    references: [reference],
    confidence: 0.99
  };
}

test('普通与流式入口形成两张工单的有序轮次，并隔离轮次引用与事实引用', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const firstInput = '帮我创建工单，网络很慢';
    const secondInput = '帮我创建工单，网络超时';
    const firstPending = await session.turn(firstInput);
    assert.equal(firstPending.status, 'awaiting_confirmation');
    const firstCompleted = await session.confirm(true);
    assert.equal(firstCompleted.status, 'executed');

    const streamEvents: Array<{ type: string }> = [];
    const secondPending = await session.turnStreamed(secondInput, (event) => streamEvents.push(event));
    assert.equal(secondPending.status, 'awaiting_confirmation');
    assert.equal(streamEvents.at(-1)?.type, 'done');
    const secondCompleted = await session.confirm(true);
    assert.equal(secondCompleted.status, 'executed');

    const state = await session.state();
    const context = state.context;
    const turns = context.conversationTurns?.turns ?? [];
    const facts = context.factHistory?.records ?? [];
    assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2, 3, 4]);
    assert.deepEqual(turns.map((turn) => turn.userText), [firstInput, '（确认执行）', secondInput, '（确认执行）']);
    assert.deepEqual(turns.map((turn) => turn.outcome), ['awaiting_confirmation', 'completed', 'awaiting_confirmation', 'completed']);
    assert.deepEqual(facts.map((record) => record.sequence), [1, 2]);
    assert.equal(facts.length, 2);
    assert.notEqual(facts[0]?.recordId, facts[1]?.recordId);
    assert.notEqual(facts[0]?.values.ticketId, facts[1]?.values.ticketId);
    assert.equal(state.events.filter((event) => event.eventName === 'action.completed').length, 2);
    assert.deepEqual(state.events.filter((event) => event.eventName === 'conversation.turn.completed').map((event) => {
      const payload = event.payload as { turn?: { sequence?: number } };
      return payload.turn?.sequence;
    }), [1, 2, 3, 4]);

    const routing = routingOf(session);
    const previousQuestion = routing.resolveReferences(referenceFrame({
      text: 'previous-question', scope: 'conversation_turn', relation: 'previous',
      anchorId: turns[3]!.turnId, anchorSequence: turns[3]!.sequence
    }), context);
    assert.equal(previousQuestion.ok, true);
    assert.equal(previousQuestion.references[0]?.turn?.sequence, 3);
    assert.equal(previousQuestion.references[0]?.turn?.userText, secondInput);

    const numberedTurn = routing.resolveReferences(referenceFrame({
      text: 'turn-1', scope: 'conversation_turn', relation: 'current', targetSequence: 1
    }), context);
    assert.equal(numberedTurn.ok, true);
    assert.equal(numberedTurn.references[0]?.turn?.turnId, turns[0]?.turnId);
    assert.equal(numberedTurn.references[0]?.record, undefined);

    const numberedFact = routing.resolveReferences(referenceFrame({
      text: 'fact-2', scope: 'fact_history', relation: 'current', targetSequence: 2
    }), context);
    assert.equal(numberedFact.ok, true);
    assert.equal(numberedFact.references[0]?.record?.recordId, facts[1]?.recordId);
    assert.equal(numberedFact.references[0]?.turn, undefined);
    assert.deepEqual((await session.state()).context.factHistory?.records.map((record) => record.sequence), [1, 2]);
  } finally {
    session.dispose();
  }
});

test('清空快照后重启仍恢复事实数量、轮次顺序和引用作用域', async () => {
  const provider = new MemoryPersistenceProvider();
  const first = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-context-restart', persistenceProvider: provider });
  try {
    assert.equal((await first.turn('帮我创建工单，网络很慢')).status, 'awaiting_confirmation');
    assert.equal((await first.confirm(true)).status, 'executed');
    assert.equal((await first.turnStreamed('帮我创建工单，网络超时', () => undefined)).status, 'awaiting_confirmation');
    assert.equal((await first.confirm(true)).status, 'executed');
    await first.flushPersistence();
  } finally {
    first.dispose();
  }

  const persistedTurnSequences = provider.events.filter((event) => event.eventName === 'conversation.turn.completed').map((event) => {
    const payload = event.payload as { turn?: { sequence?: number } };
    return payload.turn?.sequence;
  });
  assert.deepEqual(persistedTurnSequences, [1, 2, 3, 4]);
  provider.snapshots.length = 0;

  const restored = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-context-restart', persistenceProvider: provider });
  try {
    await restored.whenReady();
    const state = await restored.state();
    const context = state.context;
    const turns = context.conversationTurns?.turns ?? [];
    const facts = context.factHistory?.records ?? [];
    assert.deepEqual(turns.map((turn) => turn.sequence), [1, 2, 3, 4]);
    assert.deepEqual(facts.map((record) => record.sequence), [1, 2]);
    assert.equal(facts.length, 2);
    assert.equal(provider.events.filter((event) => event.eventName === 'action.completed').length, 2);

    const routing = routingOf(restored);
    const lastFact = routing.resolveReferences(referenceFrame({
      text: 'last-fact', scope: 'fact_history', relation: 'last'
    }), context);
    assert.equal(lastFact.ok, true);
    assert.equal(lastFact.references[0]?.record?.sequence, 2);
    assert.equal(lastFact.references[0]?.turn, undefined);

    const firstTurn = routing.resolveReferences(referenceFrame({
      text: 'first-turn', scope: 'conversation_turn', relation: 'first'
    }), context);
    assert.equal(firstTurn.ok, true);
    assert.equal(firstTurn.references[0]?.turn?.sequence, 1);
    assert.equal(firstTurn.references[0]?.record, undefined);
  } finally {
    restored.dispose();
  }
});
