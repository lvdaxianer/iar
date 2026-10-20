/**
 * SQLite Provider 的单线程数据库 Worker。
 *
 * 所有 SQLite 操作只在 Worker 中执行，避免同步 node:sqlite 阻塞 HTTP 事件循环。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type { EventEnvelope } from '@iar/contracts';
import { MAX_SESSION_SUMMARY_LENGTH, type SessionMessage, type SessionListPage, type SessionSnapshotRecord } from '../spi/types.js';

type WorkerRequest =
  | { id: number; type: 'ready' }
  | { id: number; type: 'append_message'; sessionId: string; runId: string; traceId?: string; message: SessionMessage }
  | { id: number; type: 'append_event'; sessionId: string; runId: string; traceId?: string; event: EventEnvelope }
  | { id: number; type: 'save_snapshot'; snapshot: SessionSnapshotRecord }
  | { id: number; type: 'load_snapshot'; sessionId: string }
  | { id: number; type: 'list_messages'; sessionId: string; limit?: number }
  | { id: number; type: 'list_sessions'; limit: number; cursor?: string }
  | { id: number; type: 'list_events'; sessionId: string }
  | { id: number; type: 'flush' };

type WorkerResponse = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: { code: string; message: string } };

const database = new DatabaseSync(String(workerData.filename));
initializeDatabase(database);
const port = parentPort;
if (!port) throw new Error('persistence_worker_port_missing');

port.on('message', (request: WorkerRequest) => {
  try {
    port.postMessage({ id: request.id, ok: true, result: handleRequest(request) } satisfies WorkerResponse);
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: normalizeError(error) } satisfies WorkerResponse);
  }
});

/** 初始化 Provider 专用表，按 sessionId 隔离消息、事件和快照。 */
function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS iar_session_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      trace_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_iar_session_messages_session ON iar_session_messages (session_id, sequence);
    CREATE TABLE IF NOT EXISTS iar_session_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      trace_id TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_iar_session_events_session ON iar_session_events (session_id, sequence);
    CREATE TABLE IF NOT EXISTS iar_session_snapshots (
      session_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      context TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS iar_session_index (
      session_id TEXT PRIMARY KEY,
      summary TEXT,
      activity_sequence INTEGER NOT NULL
    );
  `);
  backfillSessionIndex(database);
}

/** 执行单个有序请求；Worker 消息队列保证写入顺序。 */
function handleRequest(request: WorkerRequest): unknown {
  switch (request.type) {
    case 'ready': return true;
    case 'append_message': return appendMessage(request);
    case 'append_event': return appendEvent(request);
    case 'save_snapshot': return saveSnapshot(request.snapshot);
    case 'load_snapshot': return loadSnapshot(request.sessionId);
    case 'list_messages': return listMessages(request.sessionId, request.limit);
    case 'list_sessions': return listSessions(request.limit, request.cursor);
    case 'list_events': return listEvents(request.sessionId);
    case 'flush': return true;
  }
}

/** 追加消息；相同 messageId 和完整内容重复提交时保持幂等。 */
function appendMessage(request: Extract<WorkerRequest, { type: 'append_message' }>): void {
  const payload = JSON.stringify(request.message);
  const existing = database.prepare('SELECT session_id, run_id, trace_id, payload FROM iar_session_messages WHERE message_id = ?').get(request.message.messageId);
  if (existing) {
    if (String(existing.session_id) !== request.sessionId || String(existing.run_id) !== request.runId || nullableString(existing.trace_id) !== (request.traceId ?? null) || String(existing.payload) !== payload) {
      throw workerError('message_id_conflict', 'messageId 已绑定其他内容');
    }
    return;
  }
  database.prepare('INSERT INTO iar_session_messages (message_id, session_id, run_id, trace_id, payload) VALUES (?, ?, ?, ?, ?)').run(request.message.messageId, request.sessionId, request.runId, request.traceId ?? null, payload);
  touchSessionIndex(database, request.sessionId, request.message.role === 'user' ? request.message.content : undefined, false);
}

/** 追加事件；相同 eventId 和完整内容重复提交时保持幂等。 */
function appendEvent(request: Extract<WorkerRequest, { type: 'append_event' }>): void {
  const payload = JSON.stringify(request.event);
  const existing = database.prepare('SELECT session_id, run_id, trace_id, payload FROM iar_session_events WHERE event_id = ?').get(request.event.eventId);
  if (existing) {
    if (String(existing.session_id) !== request.sessionId || String(existing.run_id) !== request.runId || nullableString(existing.trace_id) !== (request.traceId ?? null) || String(existing.payload) !== payload) {
      throw workerError('event_id_conflict', 'eventId 已绑定其他内容');
    }
    return;
  }
  database.prepare('INSERT INTO iar_session_events (event_id, session_id, run_id, trace_id, payload) VALUES (?, ?, ?, ?, ?)').run(request.event.eventId, request.sessionId, request.runId, request.traceId ?? null, payload);
  touchSessionIndex(database, request.sessionId, undefined, false);
}

/** 保存最新快照并阻止旧版本覆盖新版本。 */
function saveSnapshot(snapshot: SessionSnapshotRecord): void {
  const current = database.prepare('SELECT run_id, event_id, revision, context FROM iar_session_snapshots WHERE session_id = ?').get(snapshot.sessionId);
  if (current) {
    const currentRevision = Number(current.revision);
    if (snapshot.revision < currentRevision) throw workerError('snapshot_revision_conflict', '快照版本回退');
    if (snapshot.revision === currentRevision) {
      if (String(current.event_id) !== snapshot.eventId || String(current.context) !== JSON.stringify(snapshot.context)) throw workerError('snapshot_revision_conflict', '同版本快照内容冲突');
      return;
    }
  }
  database.prepare(`
    INSERT INTO iar_session_snapshots (session_id, run_id, event_id, revision, context)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      run_id = excluded.run_id,
      event_id = excluded.event_id,
      revision = excluded.revision,
      context = excluded.context
  `).run(snapshot.sessionId, snapshot.runId, snapshot.eventId, snapshot.revision, JSON.stringify(snapshot.context));
  touchSessionIndex(database, snapshot.sessionId, snapshot.context.summary?.text, true);
}

/** 读取指定会话的最新结构化上下文快照。 */
function loadSnapshot(sessionId: string): SessionSnapshotRecord | undefined {
  const row = database.prepare('SELECT session_id, run_id, event_id, revision, context FROM iar_session_snapshots WHERE session_id = ?').get(sessionId);
  if (!row) return undefined;
  return { sessionId: String(row.session_id), runId: String(row.run_id), eventId: String(row.event_id), revision: Number(row.revision), context: JSON.parse(String(row.context)) } as SessionSnapshotRecord;
}

/** 按接收顺序读取指定会话消息。 */
function listMessages(sessionId: string, limit?: number): SessionMessage[] {
  const rows = limit === undefined
    ? database.prepare('SELECT payload FROM iar_session_messages WHERE session_id = ? ORDER BY sequence').all(sessionId)
    : database.prepare('SELECT payload FROM iar_session_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT ?').all(sessionId, limit).reverse();
  return rows.map((row) => JSON.parse(String(row.payload)) as SessionMessage);
}

/** 按接收顺序读取指定会话事件。 */
function listEvents(sessionId: string): EventEnvelope[] {
  return database.prepare('SELECT payload FROM iar_session_events WHERE session_id = ? ORDER BY sequence').all(sessionId).map((row) => JSON.parse(String(row.payload)) as EventEnvelope);
}

/** 按活动序号倒序读取会话摘要页，游标只携带不透明的内部位置。 */
function listSessions(limit: number, cursor?: string): SessionListPage {
  const position = cursor === undefined ? undefined : decodeCursor(cursor);
  const rows = position === undefined
    ? database.prepare('SELECT session_id, summary, activity_sequence FROM iar_session_index ORDER BY activity_sequence DESC, session_id DESC LIMIT ?').all(limit + 1)
    : database.prepare('SELECT session_id, summary, activity_sequence FROM iar_session_index WHERE activity_sequence < ? OR (activity_sequence = ? AND session_id < ?) ORDER BY activity_sequence DESC, session_id DESC LIMIT ?').all(position.activitySequence, position.activitySequence, position.sessionId, limit + 1);
  const page = rows.slice(0, limit);
  const sessions = page.map((row) => ({ sessionId: String(row.session_id), ...(row.summary === null || row.summary === undefined || String(row.summary).length === 0 ? {} : { summary: String(row.summary) }) }));
  if (rows.length <= limit || page.length === 0) return { sessions };
  const last = page.at(-1);
  if (!last) return { sessions };
  return { sessions, nextCursor: encodeCursor({ activitySequence: Number(last.activity_sequence), sessionId: String(last.session_id) }) };
}

/** 启动时为旧数据库补建会话索引，不改写原始消息、事件或快照。 */
function backfillSessionIndex(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT session_id FROM iar_session_messages
    UNION SELECT session_id FROM iar_session_events
    UNION SELECT session_id FROM iar_session_snapshots
  `).all();
  for (const row of rows) {
    const sessionId = String(row.session_id);
    const current = database.prepare('SELECT summary FROM iar_session_index WHERE session_id = ?').get(sessionId);
    const snapshotSummary = readSnapshotSummary(database, sessionId);
    const fallback = snapshotSummary ?? readFirstUserMessage(database, sessionId);
    if (!current) touchSessionIndex(database, sessionId, fallback, true);
    else if ((current.summary === null || current.summary === undefined || String(current.summary).length === 0) && fallback !== undefined) database.prepare('UPDATE iar_session_index SET summary = ? WHERE session_id = ?').run(boundSummary(fallback), sessionId);
  }
}

/** 更新会话索引；summary 只用于展示，不进入可信上下文。 */
function touchSessionIndex(database: DatabaseSync, sessionId: string, candidate: string | undefined, replaceSummary: boolean): void {
  const current = database.prepare('SELECT summary FROM iar_session_index WHERE session_id = ?').get(sessionId);
  const normalized = candidate === undefined ? undefined : boundSummary(candidate);
  const summary = replaceSummary && normalized !== undefined ? normalized : current?.summary ?? normalized ?? null;
  const activitySequence = nextActivitySequence(database);
  if (current) database.prepare('UPDATE iar_session_index SET summary = ?, activity_sequence = ? WHERE session_id = ?').run(summary, activitySequence, sessionId);
  else database.prepare('INSERT INTO iar_session_index (session_id, summary, activity_sequence) VALUES (?, ?, ?)').run(sessionId, summary, activitySequence);
}

/** 分配稳定的内部活动序号。 */
function nextActivitySequence(database: DatabaseSync): number {
  const row = database.prepare('SELECT COALESCE(MAX(activity_sequence), 0) + 1 AS next_sequence FROM iar_session_index').get();
  return Number(row?.next_sequence ?? 1);
}

/** 读取已保存快照中的展示摘要。 */
function readSnapshotSummary(database: DatabaseSync, sessionId: string): string | undefined {
  const row = database.prepare('SELECT context FROM iar_session_snapshots WHERE session_id = ?').get(sessionId);
  if (!row) return undefined;
  try {
    const context = JSON.parse(String(row.context)) as { summary?: { text?: unknown } };
    return typeof context.summary?.text === 'string' && context.summary.text.trim().length > 0 ? context.summary.text : undefined;
  } catch {
    return undefined;
  }
}

/** 读取首条用户消息作为摘要回退。 */
function readFirstUserMessage(database: DatabaseSync, sessionId: string): string | undefined {
  const rows = database.prepare('SELECT payload FROM iar_session_messages WHERE session_id = ? ORDER BY sequence').all(sessionId);
  for (const row of rows) {
    try {
      const message = JSON.parse(String(row.payload)) as { role?: unknown; content?: unknown };
      if (message.role === 'user' && typeof message.content === 'string' && message.content.trim().length > 0) return message.content;
    } catch { /* 忽略损坏消息，保留其他持久化状态。 */ }
  }
  return undefined;
}

/** 限制摘要展示长度。 */
function boundSummary(value: string): string {
  return Array.from(value).slice(0, MAX_SESSION_SUMMARY_LENGTH).join('');
}

type SessionCursor = { activitySequence: number; sessionId: string };
function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): SessionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionCursor>;
    const activitySequence = parsed.activitySequence;
    if (typeof activitySequence !== 'number' || !Number.isSafeInteger(activitySequence) || activitySequence < 1 || typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) throw new Error('cursor_invalid');
    return { activitySequence, sessionId: parsed.sessionId };
  } catch {
    throw workerError('session_list_query_invalid', '会话摘要查询游标无效');
  }
}

/** 把 SQLite/校验异常转换成不泄露底层细节的稳定错误。 */
function normalizeError(error: unknown): { code: string; message: string } {
  if (isWorkerError(error)) return { code: error.code, message: error.message };
  return { code: 'sqlite_failure', message: 'SQLite 持久化失败' };
}

/** 创建 Worker 内部稳定错误。 */
function workerError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** 判断异常是否带有 Worker 稳定错误码。 */
function isWorkerError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string';
}

/** 统一读取 SQLite 可空字段。 */
function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
