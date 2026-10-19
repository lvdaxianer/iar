/**
 * 验证 EventStore、SnapshotStore、RegistryStore 和 BehaviorContext 重放。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  InMemoryEventStore,
  InMemoryRegistryStore,
  InMemorySnapshotStore,
  SqliteEventStore,
  SqliteRegistryStore,
  SqliteSnapshotStore,
  StorageValidationError,
  type RegistryEntry
} from '@iar/storage';
import {
  BehaviorContextProjector,
  ActionIdempotencyLedger,
  RegistryActionIdempotencyStore,
  criticalFieldHash,
  replayEvents,
  ReplayValidationError
} from '@iar/runtime';
import type { ActionDefinition, BehaviorContext, EventEnvelope } from '@iar/contracts';

/*
 * 事件事实源只允许追加，不允许用快照回写历史事件。
 * EventStore 的批量追加必须在冲突或克隆失败时保持原子。
 * SnapshotStore 通过 revision 阻止旧状态覆盖新状态。
 * RegistryStore 的 putIfAbsent 支撑 Action 幂等门禁的原子首次写入。
 * SQLite 适配器与内存适配器共享同一组读写契约。
 * BehaviorContext 的关键字段必须能够从事件序列恢复。
 * subject 保留来源和 sourceEventId，避免压缩丢失主语出处。
 * route 固定 Function 和 Plugin，重试不能重新选择实现。
 * slots、pending、confirmation 和 workflowId 都属于可执行状态。
 * 关键字段 hash 由 Runtime 计算，调用方不能自带期望哈希绕过校验。
 * replay 只接受单一 runId、唯一 eventId 和单调时间序列。
 * Action 幂等记录可使用 RegistryStore，在 ledger 重建后继续生效。
 * 事件和快照返回值必须与内部存储隔离，防止调用方污染事实。
 * 所有测试只使用 Node.js 内置能力，不依赖网络、模型或外部服务。
 * 这些测试覆盖 Task 1.4 的存储、投影、重放和恢复不变量。
 */

/**
 * 创建完整的可重放行为上下文 fixture。
 *
 * @returns 带有正确关键字段哈希的上下文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function context(): BehaviorContext {
  const value: BehaviorContext = {
    schemaVersion: 'iar.behavior-context/v1',
    subject: { type: 'dip.service', id: 'test1', status: 'resolved', source: 'event', sourceEventId: 'evt-1' },
    intent: 'service.stop',
    action: { name: 'stop', status: 'resolved' },
    route: { functionId: 'dip.service.stop', pluginId: 'dip-api-stop-v1' },
    slots: { serviceId: { value: 'test1', status: 'confirmed', sourceEventId: 'evt-1' } },
    workflow: { workflowId: 'stop-service-v1', currentStep: 'await_confirmation', status: 'waiting' },
    pending: { kind: 'confirmation', status: 'required' },
    confirmation: { state: 'required', scopeHash: 'scope-1' },
    idempotencyKey: 'stop:run-1:test1',
    integrity: { criticalFieldHash: '', lastEventId: 'evt-1' }
  };
  value.integrity.criticalFieldHash = criticalFieldHash(value);
  return value;
}

/**
 * 创建最小事件 fixture。
 *
 * @param eventId - 稳定事件标识
 * @param eventName - 事件名称
 * @param payload - 可重放事件载荷
 * @returns 事件外壳
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function event(eventId: string, eventName: EventEnvelope['eventName'], payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: 'iar.event/v1',
    eventId,
    eventName,
    occurredAt: '2026-10-17T00:00:00.000Z',
    runId: 'run-1',
    correlationId: 'corr-1',
    payload
  } as EventEnvelope;
}

/**
 * 创建可测试的 Action fixture。
 *
 * @param idempotencyKey - 幂等键
 * @param actionId - Action 标识
 * @returns Action 定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(idempotencyKey: string, actionId = 'action-1'): ActionDefinition {
  return {
    schemaVersion: 'iar.action/v1',
    actionId,
    runId: 'run-1',
    functionId: 'dip.service.stop',
    pluginId: 'dip-api-stop-v1',
    idempotencyKey,
    input: { serviceId: 'test1' },
    riskLevel: 'high',
    confirmationRequired: true
  };
}

/**
 * 创建内存适配器组合。
 *
 * @returns 共享测试结构
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function stores(): Array<{
  name: string;
  eventStore: InMemoryEventStore | SqliteEventStore;
  snapshotStore: InMemorySnapshotStore | SqliteSnapshotStore;
  registryStore: InMemoryRegistryStore | SqliteRegistryStore;
  close?: () => void;
}> {
  const memory = {
    name: 'memory',
    eventStore: new InMemoryEventStore(),
    snapshotStore: new InMemorySnapshotStore(),
    registryStore: new InMemoryRegistryStore()
  };
  return [memory];
}

test('event sequence replays into the same deterministic context', () => {
  const events = [
    event('evt-1', 'workflow.started', { subjectId: 'test1', subjectType: 'dip.service', intent: 'service.stop' }),
    event('evt-2', 'decision.created', { functionId: 'dip.service.stop', pluginId: 'dip-api-stop-v1', choice: 'dip-api-stop-v1' }),
    event('evt-3', 'workflow.transitioned', {
      workflowId: 'stop-service-v1',
      currentStep: 'await_confirmation',
      status: 'waiting',
      idempotencyKey: 'stop:run-1:test1',
      actionName: 'stop',
      actionStatus: 'resolved',
      slots: { serviceId: { value: 'test1', status: 'confirmed', sourceEventId: 'evt-1' } },
      pending: { kind: 'confirmation', status: 'required' },
      confirmation: { state: 'required', scopeHash: 'scope-1' }
    })
  ];
  const first = replayEvents(events);
  const second = replayEvents(events);
  assert.deepEqual(first, second);
  assert.equal(first.route.pluginId, 'dip-api-stop-v1');
  assert.equal(first.route.functionId, 'dip.service.stop');
  assert.equal(first.workflow.currentStep, 'await_confirmation');
  assert.equal(first.workflow.workflowId, 'stop-service-v1');
  assert.equal(first.slots.serviceId?.value, 'test1');
  assert.equal(first.slots.serviceId?.status, 'confirmed');
  assert.equal(first.slots.serviceId?.sourceEventId, 'evt-1');
  assert.equal(first.subject.source, 'event');
  assert.equal(first.subject.sourceEventId, 'evt-1');
  assert.equal(first.pending.kind, 'confirmation');
  assert.equal(first.pending.status, 'required');
  assert.equal(first.confirmation.state, 'required');
  assert.equal(first.confirmation.scopeHash, 'scope-1');
  assert.equal(first.idempotencyKey, 'stop:run-1:test1');
  assert.equal(first.action.name, 'stop');
  assert.equal(first.workflow.status, 'waiting');
  assert.equal(first.action.status, 'resolved');
  assert.equal(first.integrity.criticalFieldHash, criticalFieldHash(first));
  assert.equal(first.integrity.lastEventId, 'evt-3');
});

test('critical hash changes are detected before replacing a snapshot', () => {
  const projector = new BehaviorContextProjector(context());
  const original = projector.current();
  const changed = { ...original, route: { ...original.route, pluginId: 'other-plugin-v1' } };
  const result = projector.replaceIfIntegrityMatches(changed);
  assert.equal(result.ok, false);
  assert.deepEqual(projector.current(), original);
});

test('duplicate idempotency key returns the first action without a second start event', async () => {
  const ledger = new ActionIdempotencyLedger();
  const first = await ledger.start(action('stop:run-1:test1', 'action-1'));
  const duplicate = await ledger.start(action('stop:run-1:test1', 'action-2'));
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'action.duplicate_idempotency_key');
  assert.equal((await ledger.started()).length, 1);
});

test('persistent idempotency rejects the same key after ledger recreation', async () => {
  const registry = new InMemoryRegistryStore();
  const firstLedger = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(registry));
  const secondLedger = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(registry));
  assert.equal((await firstLedger.start(action('persisted-key', 'action-1'))).ok, true);
  const duplicate = await secondLedger.start(action('persisted-key', 'action-2'));
  assert.equal(duplicate.ok, false);
  assert.equal((await secondLedger.started()).length, 1);
});

test('in-memory stores preserve events, snapshots and registry entries', async () => {
  const [store] = stores();
  assert.ok(store);
  const evt = event('evt-store-1', 'workflow.started', { subjectId: 'test1' });
  await store.eventStore.append(evt);
  await store.snapshotStore.save({ runId: 'run-1', eventId: evt.eventId, revision: 1, context: context() });
  const entry: RegistryEntry = { key: 'plugin-1', value: { state: 'enabled' } };
  await store.registryStore.put(entry);
  assert.deepEqual(await store.eventStore.list('run-1'), [evt]);
  assert.equal((await store.snapshotStore.get('run-1'))?.eventId, evt.eventId);
  assert.deepEqual((await store.registryStore.get('plugin-1'))?.value, entry.value);
});

test('in-memory event batch is atomic when cloning a later event fails', async () => {
  const store = new InMemoryEventStore();
  const valid = event('evt-atomic-1', 'workflow.started', { subjectId: 'test1' });
  const invalid = { ...valid, eventId: 'evt-atomic-2', payload: { bad: () => undefined } } as unknown as EventEnvelope;
  await assert.rejects(store.appendAll([valid, invalid]));
  assert.deepEqual(await store.list(), []);
});

test('memory and SQLite reject the same non-JSON event values', async () => {
  const invalid = event('evt-invalid-json', 'workflow.started', { value: Number.NaN });
  const memory = new InMemoryEventStore();
  const database = new DatabaseSync(':memory:');
  const sqlite = new SqliteEventStore(database);
  await assert.rejects(memory.append(invalid), StorageValidationError);
  await assert.rejects(sqlite.append(invalid), StorageValidationError);
  database.close();
});

test('storage rejects malformed event envelopes and sparse JSON arrays', async () => {
  const malformed = { ...event('', 'unknown.event' as EventEnvelope['eventName'], { value: 'x' }), runId: '' } as unknown as EventEnvelope;
  const sparse = event('evt-sparse', 'workflow.started', { values: new Array(1) });
  const memory = new InMemoryEventStore();
  const database = new DatabaseSync(':memory:');
  const sqlite = new SqliteEventStore(database);
  await assert.rejects(memory.append(malformed), StorageValidationError);
  await assert.rejects(sqlite.append(malformed), StorageValidationError);
  await assert.rejects(memory.append(sparse), StorageValidationError);
  await assert.rejects(sqlite.append(sparse), StorageValidationError);
  database.close();
});

test('stale snapshots and mixed-run replay are rejected', async () => {
  const snapshotStore = new InMemorySnapshotStore();
  await snapshotStore.save({ runId: 'run-1', eventId: 'evt-new', revision: 2, context: context() });
  await assert.rejects(snapshotStore.save({ runId: 'run-1', eventId: 'evt-old', revision: 1, context: context() }));
  assert.equal((await snapshotStore.get('run-1'))?.eventId, 'evt-new');
  const first = event('evt-run-1', 'workflow.started', { subjectId: 'test1' });
  const second = { ...first, eventId: 'evt-run-2', runId: 'run-2' };
  assert.throws(() => replayEvents([first, second]), ReplayValidationError);
});

test('replay compares parsed instants and rejects invalid timestamps', () => {
  const first = { ...event('evt-time-1', 'workflow.started', { subjectId: 'test1' }), occurredAt: '2026-01-01T00:00:00-09:00' };
  const second = { ...event('evt-time-2', 'workflow.transitioned', { currentStep: 'done', status: 'completed' }), occurredAt: '2026-01-01T01:00:00Z' };
  assert.throws(() => replayEvents([first, second]), ReplayValidationError);
  const invalid = { ...first, eventId: 'evt-time-invalid', occurredAt: 'not-a-date' };
  assert.throws(() => replayEvents([invalid]), ReplayValidationError);
});

test('replay rejects event payloads that would create an invalid context', () => {
  const invalid = event('evt-invalid-context', 'workflow.started', { subjectId: '', subjectType: '', intent: '' });
  assert.throws(() => replayEvents([invalid]), ReplayValidationError);
});

test('projector rolls back state when one event would invalidate context', () => {
  const projector = new BehaviorContextProjector(context());
  const original = projector.current();
  const invalid = event('evt-invalid-direct', 'workflow.started', { subjectId: '', subjectType: '', intent: '' });
  assert.throws(() => projector.apply(invalid));
  assert.deepEqual(projector.current(), original);
});

test('snapshot revision must be a finite non-negative integer', async () => {
  const memory = new InMemorySnapshotStore();
  const database = new DatabaseSync(':memory:');
  const sqlite = new SqliteSnapshotStore(database);
  const invalidRevisions = [Number.POSITIVE_INFINITY, -1, 1.5];
  for (const revision of invalidRevisions) {
    const snapshot = { runId: 'run-invalid', eventId: `evt-${revision}`, revision, context: context() };
    await assert.rejects(memory.save(snapshot), StorageValidationError);
    await assert.rejects(sqlite.save(snapshot), StorageValidationError);
  }
  database.close();
});

test('SQLite adapters persist the same store contracts', async () => {
  const database = new DatabaseSync(':memory:');
  const eventStore = new SqliteEventStore(database);
  const snapshotStore = new SqliteSnapshotStore(database);
  const registryStore = new SqliteRegistryStore(database);
  const evt = event('evt-sqlite-1', 'workflow.started', { subjectId: 'test1' });
  await eventStore.append(evt);
  const batch = [
    event('evt-sqlite-batch-1', 'workflow.started', { subjectId: 'test1' }),
    event('evt-sqlite-batch-2', 'workflow.transitioned', { currentStep: 'await_confirmation', status: 'waiting' })
  ];
  await eventStore.appendAll(batch);
  assert.deepEqual((await eventStore.list()).slice(1).map((item) => item.eventId), ['evt-sqlite-batch-1', 'evt-sqlite-batch-2']);
  assert.equal((await eventStore.list('run-1')).length, 3);
  assert.equal(replayEvents(await eventStore.list('run-1')).subject.id, 'test1');
  await snapshotStore.save({ runId: 'run-1', eventId: evt.eventId, revision: 1, context: context() });
  const updatedContext = { ...context(), route: { ...context().route, pluginId: 'updated-plugin-v1' } };
  updatedContext.integrity.criticalFieldHash = criticalFieldHash(updatedContext);
  await snapshotStore.save({ runId: 'run-1', eventId: 'evt-sqlite-batch-2', revision: 2, context: updatedContext });
  assert.equal((await snapshotStore.get('run-1'))?.revision, 2);
  assert.equal((await snapshotStore.get('run-1'))?.context.route.pluginId, 'updated-plugin-v1');
  await assert.rejects(snapshotStore.save({ runId: 'run-1', eventId: 'evt-old', revision: 0, context: context() }));
  await registryStore.put({ key: 'plugin-1', value: { state: 'enabled' } });
  assert.deepEqual(await eventStore.get(evt.eventId), evt);
  assert.equal((await snapshotStore.get('run-1'))?.context.route.pluginId, 'updated-plugin-v1');
  assert.deepEqual(await registryStore.list(), [{ key: 'plugin-1', value: { state: 'enabled' } }]);
  const persistentFirst = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(registryStore));
  const persistentSecond = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(registryStore));
  assert.equal((await persistentFirst.start(action('sqlite-key', 'action-sqlite-1'))).ok, true);
  assert.equal((await persistentSecond.start(action('sqlite-key', 'action-sqlite-2'))).ok, false);
  const invalid = { ...evt, eventId: 'evt-sqlite-invalid', payload: { bad: () => undefined } } as unknown as EventEnvelope;
  await assert.rejects(eventStore.appendAll([invalid]));
  assert.equal(await eventStore.get(invalid.eventId), undefined);
  const duplicate = { ...evt, eventId: 'evt-sqlite-duplicate' };
  await assert.rejects(eventStore.appendAll([duplicate, evt]));
  assert.equal(await eventStore.get(duplicate.eventId), undefined);
  database.close();
});

