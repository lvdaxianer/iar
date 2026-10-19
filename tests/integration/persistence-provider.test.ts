/**
 * 验证 Provider Registry、动态加载和内置 SQLite Provider 的边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EventEnvelope } from '@iar/contracts';
import {
  PersistenceProviderLoader,
  PersistenceProviderLoadError,
  PersistenceProviderRegistry,
  type PersistenceProviderConfig
} from '@iar/persistence-runtime';
import { sqlitePersistenceProviderModule, SqlitePersistenceError } from '@iar/persistence-sqlite';
import type { SessionIdentity, SessionMessage, SessionSnapshotRecord } from '@iar/persistence-spi';

const identity: SessionIdentity = { sessionId: 'session-sqlite-1', runId: 'run-1', traceId: 'trace-1', messageId: 'message-1' };
const message: SessionMessage = { messageId: 'message-1', role: 'user', content: '查询当前状态', occurredAt: '2026-10-19T00:00:00.000Z' };
const event: EventEnvelope = {
  schemaVersion: 'iar.event/v1',
  eventId: 'event-1',
  eventName: 'decision.created',
  occurredAt: '2026-10-19T00:00:00.000Z',
  runId: 'run-1',
  correlationId: 'trace-1',
  payload: { intent: 'system.status' }
};
const snapshot: SessionSnapshotRecord = {
  sessionId: 'session-sqlite-1',
  runId: 'run-1',
  eventId: 'event-1',
  revision: 1,
  context: {
    schemaVersion: 'iar.behavior-context/v1',
    subject: { type: 'system', id: 'system-1', status: 'resolved', source: 'event' },
    intent: 'system.status',
    action: { name: 'system.status', status: 'executed' },
    route: { functionId: 'system.status', pluginId: 'system-status-v1' },
    slots: {},
    workflow: { currentStep: 'done', status: 'completed' },
    pending: { kind: 'input', status: 'none' },
    confirmation: { state: 'not_required' },
    facts: {
      status: {
        value: 'healthy',
        status: 'verified',
        sourceEventId: 'event-1',
        functionId: 'system.status',
        pluginId: 'system-status-v1',
        field: 'status'
      }
    },
    idempotencyKey: 'idem-1',
    integrity: { criticalFieldHash: 'sha256:context', lastEventId: 'event-1' }
  }
};

test('registry loads the built-in SQLite Provider and preserves the provider contract', async () => {
  const registry = new PersistenceProviderRegistry();
  registry.register(sqlitePersistenceProviderModule);
  const loader = new PersistenceProviderLoader(registry);
  const provider = await loader.load({ provider: 'sqlite', options: { filename: ':memory:' } });

  assert.equal(provider.manifest.providerId, 'sqlite');
  await provider.close();
});

test('SQLite Provider persists messages, events, and the latest snapshot by sessionId', async () => {
  const provider = await new PersistenceProviderLoader(
    new PersistenceProviderRegistry([sqlitePersistenceProviderModule])
  ).load({ provider: 'sqlite', options: { filename: ':memory:' } });

  await provider.appendMessage(identity, message);
  await provider.appendEvent(identity, event);
  await provider.saveSnapshot(identity, snapshot);
  await provider.flush();

  assert.deepEqual(await provider.listMessages(identity.sessionId), [message]);
  assert.deepEqual(await provider.listEvents(identity.sessionId), [event]);
  assert.deepEqual(await provider.loadSnapshot(identity.sessionId), snapshot);
  await provider.close();
});

test('SQLite Provider makes duplicate message and event writes idempotent', async () => {
  const provider = await new PersistenceProviderLoader(
    new PersistenceProviderRegistry([sqlitePersistenceProviderModule])
  ).load({ provider: 'sqlite', options: { filename: ':memory:' } });

  await Promise.all([
    provider.appendMessage(identity, message),
    provider.appendMessage(identity, message),
    provider.appendEvent(identity, event),
    provider.appendEvent(identity, event)
  ]);
  await provider.flush();

  assert.equal((await provider.listMessages(identity.sessionId)).length, 1);
  assert.equal((await provider.listEvents(identity.sessionId)).length, 1);
  await provider.close();
});

test('SQLite Provider rejects stale snapshots and keeps the newest valid revision', async () => {
  const provider = await new PersistenceProviderLoader(
    new PersistenceProviderRegistry([sqlitePersistenceProviderModule])
  ).load({ provider: 'sqlite', options: { filename: ':memory:' } });
  try {
    await provider.saveSnapshot(identity, snapshot);
    await assert.rejects(
      provider.saveSnapshot(identity, { ...snapshot, revision: 0, eventId: 'event-old' }),
      (error: unknown) => error instanceof SqlitePersistenceError && error.code === 'snapshot_revision_conflict'
    );
    await provider.saveSnapshot(identity, { ...snapshot, revision: 2, eventId: 'event-2' });
    assert.equal((await provider.loadSnapshot(identity.sessionId))?.revision, 2);
  } finally {
    await provider.close();
  }
});

test('file-backed SQLite Provider recovers the same session after Provider restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iar-persistence-'));
  const filename = join(directory, 'session.sqlite');
  try {
    const first = await new PersistenceProviderLoader(new PersistenceProviderRegistry([sqlitePersistenceProviderModule])).load({ provider: 'sqlite', options: { filename } });
    await first.appendMessage(identity, message);
    await first.appendEvent(identity, event);
    await first.saveSnapshot(identity, snapshot);
    await first.close();

    const second = await new PersistenceProviderLoader(new PersistenceProviderRegistry([sqlitePersistenceProviderModule])).load({ provider: 'sqlite', options: { filename } });
    try {
      assert.deepEqual(await second.listMessages(identity.sessionId), [message]);
      assert.deepEqual(await second.listEvents(identity.sessionId), [event]);
      assert.deepEqual(await second.loadSnapshot(identity.sessionId), snapshot);
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite Provider keeps the asynchronous queue bounded while flush can drain it', async () => {
  const provider = await new PersistenceProviderLoader(new PersistenceProviderRegistry([sqlitePersistenceProviderModule])).load({ provider: 'sqlite', options: { filename: ':memory:', queueCapacity: 1 } });
  try {
    const first = provider.appendMessage(identity, message);
    await assert.rejects(provider.appendMessage({ ...identity, messageId: 'message-2' }, { ...message, messageId: 'message-2' }), (error: unknown) => error instanceof SqlitePersistenceError && error.code === 'provider_queue_full');
    await provider.flush();
    await first;
  } finally {
    await provider.close();
  }
});

test('loader can load an explicitly configured external Provider module', async () => {
  const opened: string[] = [];
  const external = {
    manifest: { providerId: 'external-memory', apiVersion: 'iar.persistence/v1', capabilities: ['messages'] },
    createProvider: () => ({
      manifest: { providerId: 'external-memory', apiVersion: 'iar.persistence/v1', capabilities: ['messages'] },
      open: async () => { opened.push('open'); },
      appendMessage: async () => {},
      appendEvent: async () => {},
      saveSnapshot: async () => {},
      loadSnapshot: async () => undefined,
      listEvents: async () => [],
      listMessages: async () => [],
      flush: async () => {},
      close: async () => { opened.push('close'); }
    })
  };
  const provider = await new PersistenceProviderLoader(new PersistenceProviderRegistry(), async (specifier) => specifier === 'external-provider' ? external : undefined).load({ provider: 'external-memory', module: 'external-provider' });
  assert.equal(provider.manifest.providerId, 'external-memory');
  assert.deepEqual(opened, ['open']);
  await provider.close();
  assert.deepEqual(opened, ['open', 'close']);
});

test('loader rejects an unregistered Provider instead of silently falling back', async () => {
  const registry = new PersistenceProviderRegistry();
  const config: PersistenceProviderConfig = { provider: 'missing-provider' };

  await assert.rejects(new PersistenceProviderLoader(registry).load(config), (error: unknown) => error instanceof Error && error.message.includes('Provider 未注册'));
});

test('loader rejects an external Provider with an incompatible SPI version', async () => {
  const registry = new PersistenceProviderRegistry();
  await assert.rejects(
    new PersistenceProviderLoader(registry, async () => ({
      manifest: { providerId: 'legacy-provider', apiVersion: 'iar.persistence/v0', capabilities: ['messages'] },
      createProvider: () => { throw new Error('must not be called'); }
    })).load({ provider: 'legacy-provider', module: 'legacy-provider' }),
    (error: unknown) => error instanceof PersistenceProviderLoadError && error.code === 'provider_api_unsupported'
  );
});
