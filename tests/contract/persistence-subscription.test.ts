/**
 * 验证会话状态事件到 Persistence Provider 的异步订阅桥。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContract, type BehaviorContext, type EventEnvelope } from '@iar/contracts';
import { SubscriptionDispatcher, SubscriptionRegistry, type DispatchEvent } from '@iar/subscriptions';
import {
  PersistenceSubscriptionBridge,
  type PersistenceSubscriptionProvider
} from '@iar/persistence-runtime';
import type { PersistenceProviderManifest, SessionMessage, SessionSnapshotRecord } from '@iar/persistence-spi';

const manifest: PersistenceProviderManifest = { providerId: 'test-memory', apiVersion: 'iar.persistence/v1', capabilities: ['messages', 'events', 'snapshots'] };
const context: BehaviorContext = {
  schemaVersion: 'iar.behavior-context/v1',
  subject: { type: 'ticket', id: 'ticket-1', status: 'resolved', source: 'event' },
  intent: 'ticket.query',
  action: { name: 'ticket.query', status: 'executed' },
  route: { functionId: 'ticket.query', pluginId: 'ticket-plugin-v1' },
  slots: {},
  workflow: { currentStep: 'done', status: 'completed' },
  pending: { kind: 'input', status: 'none' },
  confirmation: { state: 'not_required' },
  facts: {},
  idempotencyKey: 'idem-1',
  integrity: { criticalFieldHash: 'sha256:context', lastEventId: 'event-context' }
};
const snapshot: SessionSnapshotRecord = { sessionId: 'session-bridge-1', runId: 'run-1', eventId: 'event-context', revision: 1, context };
const message: SessionMessage = { messageId: 'message-1', role: 'user', content: '查询工单', occurredAt: '2026-10-19T00:00:00.000Z' };

class RecordingProvider implements PersistenceSubscriptionProvider {
  public readonly manifest = manifest;
  public readonly messages: SessionMessage[] = [];
  public readonly events: EventEnvelope[] = [];
  public readonly snapshots: SessionSnapshotRecord[] = [];
  public messageFailures = 0;

  public async open(): Promise<void> {}
  public async appendMessage(_identity: Parameters<PersistenceSubscriptionProvider['appendMessage']>[0], value: SessionMessage): Promise<void> {
    if (this.messageFailures > 0) { this.messageFailures -= 1; throw new Error('temporary'); }
    this.messages.push(value);
  }
  public async appendEvent(_identity: Parameters<PersistenceSubscriptionProvider['appendEvent']>[0], value: EventEnvelope): Promise<void> { this.events.push(value); }
  public async saveSnapshot(_identity: Parameters<PersistenceSubscriptionProvider['saveSnapshot']>[0], value: SessionSnapshotRecord): Promise<void> { this.snapshots.push(value); }
  public async loadSnapshot(): Promise<SessionSnapshotRecord | undefined> { return undefined; }
  public async listEvents(): Promise<EventEnvelope[]> { return []; }
  public async listMessages(): Promise<SessionMessage[]> { return []; }
  public async flush(): Promise<void> {}
  public async close(): Promise<void> {}
}

function event(eventName: DispatchEvent['eventName'], eventId: string, payload: DispatchEvent['payload'], overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return { eventId, eventName, sessionId: 'session-bridge-1', messageId: message.messageId, runId: 'run-1', correlationId: 'trace-1', payload, ...overrides };
}

function createDispatcher(provider: RecordingProvider, options?: { maxRetries?: number }): SubscriptionDispatcher {
  const registry = new SubscriptionRegistry();
  const dispatcher = new SubscriptionDispatcher(registry);
  new PersistenceSubscriptionBridge(provider, { maxRetries: options?.maxRetries ?? 0 }).install(registry, dispatcher);
  return dispatcher;
}

test('persistence bridge stores message, context snapshot, and restoration events asynchronously', async () => {
  const provider = new RecordingProvider();
  const dispatcher = createDispatcher(provider);
  dispatcher.enqueue(event('message.received', 'event-message', { message }));
  dispatcher.enqueue(event('context.updated', 'event-context', { snapshot }));
  dispatcher.enqueue(event('session.restored', 'event-restored', { revision: 1 }));

  const reports = await dispatcher.drain();
  assert.equal(reports.every((report) => report.allowed && report.executions[0]?.succeeded), true);
  assert.deepEqual(provider.messages, [message]);
  assert.equal(provider.events.length, 3);
  assert.deepEqual(provider.snapshots, [snapshot]);
  assert.equal(provider.events.every((stored) => stored.runId === 'run-1'), true);
  assert.equal(provider.events.every((stored) => validateContract('event', stored).ok), true);
});

test('persistence bridge retries provider failure without blocking the main dispatcher', async () => {
  const provider = new RecordingProvider();
  provider.messageFailures = 1;
  const dispatcher = createDispatcher(provider, { maxRetries: 1 });
  dispatcher.enqueue(event('message.sent', 'event-retry', { message: { ...message, role: 'assistant', messageId: 'assistant-1' } }));

  const [report] = await dispatcher.drain();
  assert.equal(report?.allowed, true);
  assert.equal(report?.executions[0]?.attempts, 2);
  assert.equal(provider.messages.length, 1);
});

test('persistence bridge keeps missing session identity fail-open and does not write', async () => {
  const provider = new RecordingProvider();
  const dispatcher = createDispatcher(provider);
  const missingSession = event('message.received', 'event-no-session', { message });
  delete missingSession.sessionId;
  dispatcher.enqueue(missingSession);

  const [report] = await dispatcher.drain();
  assert.equal(report?.allowed, true);
  assert.equal(report?.executions[0]?.succeeded, false);
  assert.equal(provider.messages.length, 0);
  assert.equal(provider.events.length, 0);
});

test('duplicate state event is executed once by the subscription idempotency boundary', async () => {
  const provider = new RecordingProvider();
  const dispatcher = createDispatcher(provider);
  const persisted = event('session.restored', 'event-duplicate', { revision: 1 });
  dispatcher.enqueue(persisted);
  dispatcher.enqueue(persisted);

  await dispatcher.drain();
  assert.equal(provider.events.length, 1);
});
