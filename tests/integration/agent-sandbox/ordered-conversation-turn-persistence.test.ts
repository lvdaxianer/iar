/** 验证有序会话轮次经持久化桥、事件重放和上下文压缩后仍可恢复。
 * 测试故意清空快照，确保恢复逻辑不会只依赖最新 snapshot。
 * 原始消息窗口和结构化轮次分别断言，避免把两者混成同一种上下文。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '@iar/contracts';
import type { PersistenceProviderManifest, RecentMessageQuery, SessionIdentity, SessionListPage, SessionListQuery, SessionMessage, SessionPersistenceProvider, SessionSnapshotRecord } from '@iar/storage';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

const manifest: PersistenceProviderManifest = { providerId: 'ordered-turn-test-provider', apiVersion: 'iar.persistence/v1', capabilities: ['messages', 'events', 'snapshots', 'async'] };

/** 只保存公开 SPI 数据的内存 Provider，支持模拟快照丢失后的事件恢复。 */
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

test('持久化桥保存轮次事件和包含轮次的最新快照', async () => {
  const provider = new MemoryPersistenceProvider();
  const session = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-turn-persist', persistenceProvider: provider });
  try {
    await session.turn('查询服务状态');
    await session.flushPersistence();
    assert.ok(provider.events.some((event) => event.eventName === 'conversation.turn.completed'));
    assert.equal(provider.snapshots.at(-1)?.context.conversationTurns?.turns.length, 1);
  } finally {
    session.dispose();
  }
});

test('快照缺失时从持久化事件恢复有序会话轮次', async () => {
  const provider = new MemoryPersistenceProvider();
  const first = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-turn-replay', persistenceProvider: provider });
  await first.turn('查询服务状态');
  await first.flushPersistence();
  first.dispose();
  provider.snapshots.length = 0;

  const restored = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-turn-replay', persistenceProvider: provider });
  try {
    await restored.whenReady();
    const turns = (await restored.state()).context.conversationTurns?.turns ?? [];
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.userText, '查询服务状态');
    assert.equal(turns[0]?.sequence, 1);
  } finally {
    restored.dispose();
  }
});

test('上下文压缩后仍保留轮次顺序和焦点', async () => {
  const provider = new MemoryPersistenceProvider();
  const session = new IarSandboxSession({ mode: 'scripted', sessionId: 'ordered-turn-compaction', persistenceProvider: provider });
  try {
    await session.turn('查询服务状态');
    const compacted = await session.compact();
    await session.flushPersistence();
    assert.equal(compacted.ok, true);
    const context = (await session.state()).context;
    assert.equal(context.conversationTurns?.turns.length, 1);
    assert.equal(context.conversationTurns?.focusTurnId, context.conversationTurns?.turns[0]?.turnId);
    assert.equal(provider.snapshots.at(-1)?.context.conversationTurns?.turns[0]?.sequence, 1);
  } finally {
    session.dispose();
  }
});
