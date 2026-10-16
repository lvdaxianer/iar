/**
 * 提供基于 Node.js 内置 node:sqlite 的同步 SQLite 适配器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { DatabaseSync } from 'node:sqlite';
import type { BehaviorContext, EventEnvelope } from '@iar/contracts';
import {
  StorageConflictError,
  type EventStore,
  type RegistryEntry,
  type RegistryStore,
  type SnapshotRecord,
  type SnapshotStore
} from './types.js';
import { cloneEvent, cloneJsonValue, cloneSnapshot } from './json.js';

/** 共享 SQLite 数据库的表结构初始化。 */
function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS iar_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS iar_snapshots (
      run_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      context TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS iar_registry (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/** SQLite 事件事实源。 */
export class SqliteEventStore implements EventStore {
  /** 事件表由 SQLite 负责持久化和唯一约束。 */
  public constructor(private readonly database: DatabaseSync) {
    initializeDatabase(database);
  }

  /** 插入一个不可变事件。 */
  public async append(event: EventEnvelope): Promise<void> {
    const clonedEvent = cloneEvent(event);
    try {
      const statement = this.database.prepare('INSERT INTO iar_events (event_id, run_id, payload) VALUES (?, ?, ?)');
      statement.run(clonedEvent.eventId, clonedEvent.runId, JSON.stringify(clonedEvent));
    } catch (error) {
      throw mapSqliteConflict(error, event.eventId);
    }
  }

  /** 在 SQLite 事务中原子插入多个事件。 */
  public async appendAll(events: readonly EventEnvelope[]): Promise<void> {
    const clonedEvents = events.map(cloneEvent);
    const insert = this.database.prepare('INSERT INTO iar_events (event_id, run_id, payload) VALUES (?, ?, ?)');
    const ids = new Set<string>();
    for (const event of clonedEvents) {
      if (ids.has(event.eventId)) throw new StorageConflictError(`事件已存在: ${event.eventId}`);
      ids.add(event.eventId);
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const event of clonedEvents) insert.run(event.eventId, event.runId, JSON.stringify(event));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw mapSqliteConflict(error, '批量事件');
    }
  }

  /** 按 SQLite sequence 返回事件快照。 */
  public async list(runId?: string): Promise<EventEnvelope[]> {
    const rows = runId === undefined
      ? this.database.prepare('SELECT payload FROM iar_events ORDER BY sequence').all()
      : this.database.prepare('SELECT payload FROM iar_events WHERE run_id = ? ORDER BY sequence').all(runId);
    return rows.map((row) => JSON.parse(String(row.payload)) as EventEnvelope);
  }

  /** 查询单个事件快照。 */
  public async get(eventId: string): Promise<EventEnvelope | undefined> {
    const row = this.database.prepare('SELECT payload FROM iar_events WHERE event_id = ?').get(eventId);
    return row ? JSON.parse(String(row.payload)) as EventEnvelope : undefined;
  }
}

/** SQLite BehaviorContext 快照存储。 */
export class SqliteSnapshotStore implements SnapshotStore {
  /** 初始化共享快照表。 */
  public constructor(private readonly database: DatabaseSync) {
    initializeDatabase(database);
  }

  /** 保存或替换一个运行快照。 */
  public async save(snapshot: SnapshotRecord): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.saveWithinTransaction(snapshot);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** 在已取得 SQLite 写锁的事务中执行 revision 比较和快照写入。 */
  private saveWithinTransaction(snapshot: SnapshotRecord): void {
    const current = this.database.prepare('SELECT revision, event_id FROM iar_snapshots WHERE run_id = ?').get(snapshot.runId);
    if (current && snapshot.revision < Number(current.revision)) {
      throw new StorageConflictError(`快照版本回退: ${snapshot.runId}`);
    }
    if (current && snapshot.revision === Number(current.revision) && String(current.event_id) !== snapshot.eventId) {
      throw new StorageConflictError(`快照版本冲突: ${snapshot.runId}`);
    }
    const statement = this.database.prepare(`
      INSERT INTO iar_snapshots (run_id, event_id, revision, context)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        event_id = excluded.event_id,
        revision = excluded.revision,
        context = excluded.context
    `);
    const clonedSnapshot = cloneSnapshot(snapshot);
    statement.run(clonedSnapshot.runId, clonedSnapshot.eventId, clonedSnapshot.revision, JSON.stringify(clonedSnapshot.context));
  }

  /** 读取一个运行快照。 */
  public async get(runId: string): Promise<SnapshotRecord | undefined> {
    const row = this.database.prepare('SELECT run_id, event_id, revision, context FROM iar_snapshots WHERE run_id = ?').get(runId);
    return row
      ? {
          runId: String(row.run_id),
          eventId: String(row.event_id),
          revision: Number(row.revision),
          context: JSON.parse(String(row.context)) as BehaviorContext
        }
      : undefined;
  }

  /** 删除一个运行快照。 */
  public async delete(runId: string): Promise<void> {
    this.database.prepare('DELETE FROM iar_snapshots WHERE run_id = ?').run(runId);
  }
}

/** SQLite 注册表存储。 */
export class SqliteRegistryStore implements RegistryStore {
  /** 初始化共享注册表。 */
  public constructor(private readonly database: DatabaseSync) {
    initializeDatabase(database);
  }

  /** 保存或替换一个 JSON 注册条目。 */
  public async put(entry: RegistryEntry): Promise<void> {
    const value = cloneJsonValue(entry.value);
    const statement = this.database.prepare(`
      INSERT INTO iar_registry (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    statement.run(entry.key, JSON.stringify(value));
  }

  /** 只在 key 不存在时写入，依赖 SQLite 的唯一约束保证原子性。 */
  public async putIfAbsent(entry: RegistryEntry): Promise<boolean> {
    const value = cloneJsonValue(entry.value);
    const statement = this.database.prepare('INSERT OR IGNORE INTO iar_registry (key, value) VALUES (?, ?)');
    const result = statement.run(entry.key, JSON.stringify(value));
    return result.changes > 0;
  }

  /** 读取一个 JSON 注册条目。 */
  public async get(key: string): Promise<RegistryEntry | undefined> {
    const row = this.database.prepare('SELECT key, value FROM iar_registry WHERE key = ?').get(key);
    return row ? { key: String(row.key), value: JSON.parse(String(row.value)) } : undefined;
  }

  /** 返回按 key 排序的条目。 */
  public async list(): Promise<RegistryEntry[]> {
    const rows = this.database.prepare('SELECT key, value FROM iar_registry ORDER BY key').all();
    return rows.map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) }));
  }

  /** 删除一个注册条目。 */
  public async delete(key: string): Promise<void> {
    this.database.prepare('DELETE FROM iar_registry WHERE key = ?').run(key);
  }
}

/** 将 SQLite 唯一约束转换成稳定存储冲突，其他错误保持原始类型。 */
function mapSqliteConflict(error: unknown, key: string): Error {
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return new StorageConflictError(`存储键已存在: ${key}`);
  }
  return error instanceof Error ? error : new Error('SQLite 写入失败');
}
