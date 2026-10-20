/**
 * 验证沙箱会话通过 Hook 订阅桥持久化消息、动作结果、上下文和压缩事实。
 *
 * 测试使用内存 Provider，模拟外部 Provider 接入方，不依赖具体数据库实现。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EventEnvelope } from '@iar/contracts';
import type {
  PersistenceProviderManifest,
  RecentMessageQuery,
  SessionListPage,
  SessionListQuery,
  SessionIdentity,
  SessionMessage,
  SessionPersistenceProvider,
  SessionSnapshotRecord
} from '@iar/persistence-spi';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

const manifest: PersistenceProviderManifest = {
  providerId: 'sandbox-test-provider',
  apiVersion: 'iar.persistence/v1',
  capabilities: ['messages', 'events', 'snapshots', 'async']
};

/** 一个只记录输入的 Provider，验证沙箱只依赖公开 SPI。 */
class RecordingProvider implements SessionPersistenceProvider {
  public readonly manifest = manifest;
  public readonly messages: SessionMessage[] = [];
  public readonly events: EventEnvelope[] = [];
  public readonly snapshots: SessionSnapshotRecord[] = [];
  public readonly identities: SessionIdentity[] = [];

  public async open(): Promise<void> {}

  public async appendMessage(identity: SessionIdentity, message: SessionMessage): Promise<void> {
    this.identities.push(structuredClone(identity));
    this.messages.push(structuredClone(message));
  }

  public async appendEvent(identity: SessionIdentity, event: EventEnvelope): Promise<void> {
    this.identities.push(structuredClone(identity));
    this.events.push(structuredClone(event));
  }

  public async saveSnapshot(identity: SessionIdentity, snapshot: SessionSnapshotRecord): Promise<void> {
    this.identities.push(structuredClone(identity));
    this.snapshots.push(structuredClone(snapshot));
  }

  public async loadSnapshot(): Promise<SessionSnapshotRecord | undefined> {
    return this.snapshots.at(-1);
  }

  public async listEvents(): Promise<EventEnvelope[]> {
    return structuredClone(this.events);
  }

  public async listMessages(_sessionId: string, _query?: RecentMessageQuery): Promise<SessionMessage[]> {
    return structuredClone(this.messages);
  }

  public async listSessions(_query?: SessionListQuery): Promise<SessionListPage> {
    return { sessions: [] };
  }

  public async flush(): Promise<void> {}

  public async close(): Promise<void> {}
}

test('沙箱回合将消息、动作结果和结构化上下文异步发布到 Provider', async () => {
  const provider = new RecordingProvider();
  const session = new IarSandboxSession({ mode: 'scripted', sessionId: 'hook-session-1', persistenceProvider: provider });

  try {
    const result = await session.turn('查询系统状态');
    await session.flushPersistence();

    assert.equal(result.status, 'executed');
    assert.deepEqual(provider.messages.map((message) => message.role), ['user', 'assistant']);
    assert.ok(provider.messages.every((message) => message.content.length > 0));
    assert.ok(provider.events.some((event) => event.eventName === 'action.completed'));
    assert.ok(provider.events.some((event) => event.eventName === 'context.updated'));
    assert.ok(provider.events.some((event) => event.eventName === 'message.received'));
    assert.ok(provider.events.some((event) => event.eventName === 'message.sent'));
    assert.ok(provider.snapshots.some((snapshot) => snapshot.sessionId === 'hook-session-1'));
    assert.ok(provider.identities.every((identity) => identity.sessionId === 'hook-session-1'));
    const actionIndex = provider.events.findIndex((event) => event.eventName === 'action.completed');
    assert.ok(provider.events.slice(actionIndex + 1).some((event) => event.eventName === 'context.updated'));
  } finally {
    session.dispose();
  }
});

test('沙箱压缩事实通过 context.compacted 事件和最新快照持久化', async () => {
  const provider = new RecordingProvider();
  const session = new IarSandboxSession({ mode: 'scripted', sessionId: 'hook-session-2', persistenceProvider: provider });

  try {
    await session.turn('查询系统状态');
    const compacted = await session.compact();
    await session.flushPersistence();

    assert.equal(compacted.ok, true);
    assert.ok(provider.events.some((event) => event.eventName === 'context.compacted'));
    assert.equal(provider.snapshots.at(-1)?.context.summary?.eventId, compacted.eventId);
  } finally {
    session.dispose();
  }
});

test('新会话实例按 sessionId 恢复 Provider 快照并发布恢复事件', async () => {
  const provider = new RecordingProvider();
  const first = new IarSandboxSession({ mode: 'scripted', sessionId: 'hook-session-3', persistenceProvider: provider });

  await first.turn('查询系统状态');
  await first.flushPersistence();
  const savedContext = provider.snapshots.at(-1)?.context;
  first.dispose();

  const restored = new IarSandboxSession({ mode: 'scripted', sessionId: 'hook-session-3', persistenceProvider: provider });
  try {
    await restored.whenReady();
    await restored.flushPersistence();

    assert.deepEqual((await restored.state()).context, savedContext);
    assert.ok(provider.events.some((event) => event.eventName === 'session.restored'));
  } finally {
    restored.dispose();
  }
});
