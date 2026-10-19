/**
 * 验证结构化会话快照通过独立 SQLite 工作线程异步写入。
 * 覆盖重启恢复、同会话版本顺序、队列边界、失败传播、损坏隔离和关闭排空。
 * 测试使用临时数据库，不读取生产配置，不输出快照正文。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { BehaviorContext } from '../../../packages/contracts/src/index.js';
import { criticalFieldHash } from '../../../packages/runtime/src/index.js';
import { AsyncSqliteSnapshotStore, StorageConflictError, StoragePersistenceError, type SnapshotRecord } from '../../../packages/storage/src/index.js';

/** 创建最小合法结构化上下文，业务事实只放在契约允许的 slots 中。 */
function snapshot(runId: string, revision: number, eventId = `event-${revision}`): SnapshotRecord {
  const context: BehaviorContext = {
    schemaVersion: 'iar.behavior-context/v1',
    subject: { type: 'service', id: runId, status: 'resolved', source: 'event', sourceEventId: eventId },
    intent: 'service.query', action: { name: 'query', status: 'resolved' }, route: { functionId: 'service.query', pluginId: 'plugin-v1' },
    slots: { owner: { value: 'tenant-a', status: 'resolved' } },
    workflow: { workflowId: 'workflow-v1', currentStep: 'done', status: 'completed' },
    pending: { kind: 'confirmation', status: 'none' }, confirmation: { state: 'not_required' },
    idempotencyKey: `run:${runId}`,
    integrity: { criticalFieldHash: '', lastEventId: eventId }
  };
  context.integrity.criticalFieldHash = criticalFieldHash(context);
  return { runId, revision, eventId, context };
}

/** 每个测试使用独立临时目录，并在 finally 删除全部数据库文件。 */
function temporaryDatabase(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'iar-async-snapshot-'));
  return { path: join(directory, 'session.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('快照工作线程异步写入并在重启后恢复最新版本', async () => {
  const temporary = temporaryDatabase();
  try {
    const first = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    await Promise.all([first.save(snapshot('session-a', 1)), first.save(snapshot('session-a', 2))]);
    await first.close();
    const second = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    assert.equal((await second.get('session-a'))?.revision, 2);
    await second.close();
  } finally { temporary.cleanup(); }
});

test('同会话旧版本不能覆盖新版本且不同会话彼此隔离', async () => {
  const temporary = temporaryDatabase();
  try {
    const store = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    await store.save(snapshot('session-a', 3));
    await assert.rejects(store.save(snapshot('session-a', 2)), StorageConflictError);
    await assert.rejects(store.save(snapshot('session-a', 3, 'other-event')), StorageConflictError);
    await store.save(snapshot('session-b', 1));
    assert.equal((await store.get('session-a'))?.runId, 'session-a');
    assert.equal((await store.get('session-b'))?.runId, 'session-b');
    await store.close();
  } finally { temporary.cleanup(); }
});

test('有界队列拒绝超额更新且关闭会排空已接受更新', async () => {
  const temporary = temporaryDatabase();
  try {
    const store = new AsyncSqliteSnapshotStore({ filename: temporary.path, maxQueue: 1, writeDelayMs: 40 });
    const first = store.save(snapshot('session-a', 1));
    await assert.rejects(store.save(snapshot('session-a', 2)), /snapshot_queue_full/);
    await first;
    await store.close();
    const reopened = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    assert.equal((await reopened.get('session-a'))?.revision, 1);
    await reopened.close();
  } finally { temporary.cleanup(); }
});

test('SQLite 工作线程阻塞时主线程仍可继续处理事件循环', async () => {
  const temporary = temporaryDatabase();
  try {
    const store = new AsyncSqliteSnapshotStore({ filename: temporary.path, writeDelayMs: 100 });
    let eventLoopRan = false;
    const tick = new Promise<void>((resolve) => setImmediate(() => { eventLoopRan = true; resolve(); }));
    const save = store.save(snapshot('session-a', 1));
    await tick;
    assert.equal(eventLoopRan, true);
    await save;
    await store.close();
  } finally { temporary.cleanup(); }
});

test('数据库不可写时返回稳定持久化错误并可安全关闭', async () => {
  const temporary = temporaryDatabase();
  try {
    const store = new AsyncSqliteSnapshotStore({ filename: join(temporary.path, 'missing', 'session.sqlite'), maxRetries: 1, retryDelayMs: 1 });
    await assert.rejects(store.save(snapshot('session-a', 1)), StoragePersistenceError);
    await store.close();
  } finally { temporary.cleanup(); }
});

test('损坏快照不会污染后续有效恢复', async () => {
  const temporary = temporaryDatabase();
  try {
    const store = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    await store.save(snapshot('session-a', 1)); await store.close();
    const database = new DatabaseSync(temporary.path);
    database.prepare('UPDATE iar_snapshots SET context = ? WHERE run_id = ?').run('{"invalid":true}', 'session-a');
    database.close();
    const reopened = new AsyncSqliteSnapshotStore({ filename: temporary.path });
    await assert.rejects(reopened.get('session-a'), /快照|BehaviorContext|invalid/i);
    await reopened.save(snapshot('session-b', 1));
    assert.equal((await reopened.get('session-b'))?.revision, 1);
    await reopened.close();
  } finally { temporary.cleanup(); }
});
