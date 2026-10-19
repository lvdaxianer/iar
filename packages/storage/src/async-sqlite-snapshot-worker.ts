/**
 * 在独立工作线程中执行 SQLite 快照读写。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { cloneSnapshot } from './json.js';
import { StorageConflictError, StorageValidationError, type SnapshotRecord } from './types.js';

/** 工作线程启动参数。 */
export type SnapshotWorkerData = { filename: string; writeDelayMs: number };

/** 主线程发给工作线程的操作。 */
export type SnapshotWorkerRequest =
  | { id: number; type: 'save'; snapshot: SnapshotRecord }
  | { id: number; type: 'get'; runId: string }
  | { id: number; type: 'delete'; runId: string };

/** 工作线程返回的稳定错误分类。 */
export type SnapshotWorkerError = { kind: 'conflict' | 'validation' | 'persistence'; code: string };

/** 工作线程发给主线程的消息。 */
export type SnapshotWorkerResponse =
  | { type: 'ready' }
  | { type: 'fatal'; error: SnapshotWorkerError }
  | { type: 'response'; id: number; ok: true; result?: SnapshotRecord }
  | { type: 'response'; id: number; ok: false; error: SnapshotWorkerError };

let database!: DatabaseSync;

/** 初始化快照表并打开同步 SQLite 连接。 */
function openDatabase(data: SnapshotWorkerData): DatabaseSync {
  const opened = new DatabaseSync(data.filename);
  opened.exec(`
    CREATE TABLE IF NOT EXISTS iar_snapshots (
      run_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      context TEXT NOT NULL
    )
  `);
  return opened;
}

/** 将底层异常压缩成不泄露数据库细节的稳定错误。 */
function classifyError(error: unknown): SnapshotWorkerError {
  if (error instanceof StorageConflictError) return { kind: 'conflict', code: 'snapshot_revision_conflict' };
  if (error instanceof StorageValidationError) return { kind: 'validation', code: 'snapshot_invalid' };
  return { kind: 'persistence', code: 'snapshot_persistence_failed' };
}

/** 将快照写入 SQLite，并在事务中执行版本门禁。 */
function saveSnapshot(snapshot: SnapshotRecord): void {
  const cloned = cloneSnapshot(snapshot);
  delayWrite((workerData as SnapshotWorkerData).writeDelayMs);
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('SELECT revision, event_id FROM iar_snapshots WHERE run_id = ?').get(cloned.runId);
    checkRevision(current, cloned);
    upsertSnapshot(cloned);
    database.exec('COMMIT');
  } catch (error) {
    rollbackTransaction();
    throw error;
  }
}

/** 使用主键冲突更新当前会话的完整 JSON 快照。 */
function upsertSnapshot(snapshot: SnapshotRecord): void {
  database.prepare(`
    INSERT INTO iar_snapshots (run_id, event_id, revision, context)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      event_id = excluded.event_id,
      revision = excluded.revision,
      context = excluded.context
  `).run(snapshot.runId, snapshot.eventId, snapshot.revision, JSON.stringify(snapshot.context));
}

/** 拒绝旧版本和同版本不同事件，允许同版本幂等重放。 */
function checkRevision(current: Record<string, unknown> | undefined, snapshot: SnapshotRecord): void {
  if (!current) return;
  const revision = Number(current.revision);
  if (snapshot.revision < revision) throw new StorageConflictError('snapshot_revision_conflict');
  if (snapshot.revision === revision && String(current.event_id) !== snapshot.eventId) {
    throw new StorageConflictError('snapshot_revision_conflict');
  }
}

/** 读取并再次校验持久化快照，损坏内容不会越过存储边界。 */
function getSnapshot(runId: string): SnapshotRecord | undefined {
  const row = database.prepare('SELECT run_id, event_id, revision, context FROM iar_snapshots WHERE run_id = ?').get(runId);
  if (!row) return undefined;
  try {
    return cloneSnapshot({
      runId: String(row.run_id),
      eventId: String(row.event_id),
      revision: Number(row.revision),
      context: JSON.parse(String(row.context))
    });
  } catch {
    throw new StorageValidationError('snapshot_invalid');
  }
}

/** 删除指定会话的当前快照。 */
function deleteSnapshot(runId: string): void {
  database.prepare('DELETE FROM iar_snapshots WHERE run_id = ?').run(runId);
}

/** 在工作线程内阻塞等待，避免测试延迟影响主线程事件循环。 */
function delayWrite(delayMs: number): void {
  if (delayMs <= 0) return;
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
}

/** 回滚失败时保留原始业务错误，避免工作线程丢失失败分类。 */
function rollbackTransaction(): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // 原始错误已经会被转换为稳定错误，回滚失败不再向主线程暴露细节。
  }
}

/** 处理一条已按实例顺序到达的消息。 */
function processRequest(request: SnapshotWorkerRequest): void {
  try {
    if (request.type === 'save') {
      // save 在事务中完成版本比较和完整快照替换。
      saveSnapshot(request.snapshot);
    } else if (request.type === 'get') {
      // get 返回前重新校验 JSON，损坏记录只返回稳定验证错误。
      postResponse(request.id, true, getSnapshot(request.runId));
    } else {
      // delete 与前序消息共享同一工作线程，因此天然保持实例顺序。
      deleteSnapshot(request.runId);
    }
    if (request.type !== 'get') postResponse(request.id, true);
  } catch (error) {
    postResponse(request.id, false, undefined, classifyError(error));
  }
}

/** 向主线程发送协议响应。 */
function postResponse(id: number, ok: boolean, result?: SnapshotRecord, error?: SnapshotWorkerError): void {
  const response: SnapshotWorkerResponse = ok
    ? { type: 'response', id, ok: true, ...(result === undefined ? {} : { result }) }
    : { type: 'response', id, ok: false, error: error ?? { kind: 'persistence', code: 'snapshot_persistence_failed' } };
  parentPort?.postMessage(response);
}

/** 启动工作线程消息循环；初始化失败则只发送稳定 fatal 消息。 */
function startWorker(): void {
  if (!parentPort) return;
  parentPort.postMessage({ type: 'ready' } satisfies SnapshotWorkerResponse);
  parentPort.on('message', processRequest);
}

try {
  database = openDatabase(workerData as SnapshotWorkerData);
  startWorker();
} catch (error) {
  parentPort?.postMessage({ type: 'fatal', error: classifyError(error) } satisfies SnapshotWorkerResponse);
  parentPort?.close();
}
