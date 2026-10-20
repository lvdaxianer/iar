/**
 * 内置 SQLite 会话持久化 Provider。
 *
 * Provider 通过有界消息队列和独立 Worker 执行数据库操作，避免同步 SQLite 阻塞宿主事件循环。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import { Worker } from 'node:worker_threads';
import type { EventEnvelope } from '@iar/contracts';
import {
  PERSISTENCE_API_VERSION,
  PersistenceValidationError,
  validateSessionIdentity,
  validateRecentMessageQuery,
  validateSessionListQuery,
  type PersistenceProviderFactory,
  type PersistenceProviderManifest,
  type PersistenceProviderModule,
  type PersistenceProviderOptions,
  type RecentMessageQuery,
  type SessionIdentity,
  type SessionMessage,
  type SessionListPage,
  type SessionListQuery,
  type SessionPersistenceProvider,
  type SessionSnapshotRecord
} from '../spi/types.js';

/** SQLite Provider 的可 JSON 配置。 */
export type SqlitePersistenceOptions = {
  /** 数据库文件路径，`:memory:` 适合测试和单进程运行。 */
  filename?: string;
  /** 待处理请求上限，防止异步写入无限增长。 */
  queueCapacity?: number;
};

/** SQLite Provider 的稳定错误。 */
export class SqlitePersistenceError extends Error {
  /** @param code - 稳定错误码 @param message - 不包含数据库路径和敏感内容的诊断信息 */
  public constructor(
    public readonly code: 'provider_not_open' | 'provider_closed' | 'provider_queue_full' | 'provider_worker_failed' | 'provider_config_invalid' | 'message_invalid' | 'message_query_invalid' | 'session_list_query_invalid' | 'event_invalid' | 'snapshot_invalid' | 'message_id_conflict' | 'event_id_conflict' | 'snapshot_revision_conflict' | 'sqlite_failure',
    message: string
  ) {
    super(message);
    this.name = 'SqlitePersistenceError';
  }
}

const SQLITE_MANIFEST: PersistenceProviderManifest = {
  providerId: 'sqlite',
  apiVersion: PERSISTENCE_API_VERSION,
  capabilities: ['messages', 'events', 'snapshots', 'async', 'idempotency', 'revision-check']
};
const DEFAULT_QUEUE_CAPACITY = 128;

type WorkerRequest = { id: number; type: string; [key: string]: unknown };
type WorkerResponse = { id: number; ok: true; result?: unknown } | { id: number; ok: false; error: { code: string; message: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/**
 * 通过 Worker 提供会话消息、事件和结构化快照的 SQLite 持久化。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export class SqlitePersistenceProvider implements SessionPersistenceProvider {
  public readonly manifest = SQLITE_MANIFEST;
  private worker: Worker | undefined;
  private state: 'new' | 'open' | 'closing' | 'closed' = 'new';
  private closeOperation: Promise<void> | undefined;
  private workerFailed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private queueCapacity = DEFAULT_QUEUE_CAPACITY;

  /** 初始化 Worker；重复 open 保持幂等。 */
  public async open(options?: PersistenceProviderOptions): Promise<void> {
    if (this.state === 'open') return;
    if (this.state !== 'new') throw new SqlitePersistenceError('provider_closed', 'Provider 已关闭');
    const parsed = parseOptions(options);
    this.workerFailed = false;
    this.queueCapacity = parsed.queueCapacity;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { filename: parsed.filename } });
    this.worker.on('message', (response: WorkerResponse) => this.handleResponse(response));
    this.worker.on('error', (error) => this.handleWorkerFailure(error));
    this.worker.on('exit', (code) => { if (code !== 0 && this.state === 'open') this.handleWorkerFailure(new Error(`worker_exit_${code}`)); });
    try {
      await this.enqueue({ type: 'ready' });
      this.state = 'open';
    } catch (error) {
      await this.closeWorker();
      throw error;
    }
  }

  /** 追加一条消息；相同 messageId 的完全相同写入幂等。 */
  public async appendMessage(input: SessionIdentity, message: SessionMessage): Promise<void> {
    const identity = validateSessionIdentity(input);
    validateMessage(message);
    if (identity.messageId !== undefined && identity.messageId !== message.messageId) throw new SqlitePersistenceError('message_invalid', '消息身份与持久化身份不一致');
    await this.enqueue({ type: 'append_message', sessionId: identity.sessionId, runId: identity.runId, ...(identity.traceId === undefined ? {} : { traceId: identity.traceId }), message });
  }

  /** 追加一个不可变事件；相同 eventId 的完全相同写入幂等。 */
  public async appendEvent(input: SessionIdentity, event: EventEnvelope): Promise<void> {
    const identity = validateSessionIdentity(input);
    if (event.runId !== identity.runId || !event.eventId) throw new SqlitePersistenceError('event_invalid', '事件身份与持久化身份不一致');
    await this.enqueue({ type: 'append_event', sessionId: identity.sessionId, runId: identity.runId, ...(identity.traceId === undefined ? {} : { traceId: identity.traceId }), event });
  }

  /** 保存会话最新结构化快照，拒绝跨会话或旧版本写入。 */
  public async saveSnapshot(input: SessionIdentity, snapshot: SessionSnapshotRecord): Promise<void> {
    const identity = validateSessionIdentity(input);
    if (snapshot.sessionId !== identity.sessionId || snapshot.runId !== identity.runId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !snapshot.eventId) throw new SqlitePersistenceError('snapshot_invalid', '快照身份或版本无效');
    await this.enqueue({ type: 'save_snapshot', snapshot });
  }

  /** 读取指定会话的最新有效快照。 */
  public async loadSnapshot(sessionId: string): Promise<SessionSnapshotRecord | undefined> {
    validateSessionId(sessionId);
    return await this.enqueue({ type: 'load_snapshot', sessionId }) as SessionSnapshotRecord | undefined;
  }

  /** 读取指定会话的有序事件。 */
  public async listEvents(sessionId: string): Promise<EventEnvelope[]> {
    validateSessionId(sessionId);
    return await this.enqueue({ type: 'list_events', sessionId }) as EventEnvelope[];
  }

  /** 读取指定会话的有序消息。 */
  public async listMessages(sessionId: string, query?: RecentMessageQuery): Promise<SessionMessage[]> {
    validateSessionId(sessionId);
    const validatedQuery = normalizeMessageQuery(query);
    return await this.enqueue({ type: 'list_messages', sessionId, ...(validatedQuery === undefined ? {} : { limit: validatedQuery.limit }) }) as SessionMessage[];
  }

  /** 读取有界、按活动顺序分页的会话摘要。 */
  public async listSessions(query?: SessionListQuery): Promise<SessionListPage> {
    const validatedQuery = normalizeSessionListQuery(query);
    return await this.enqueue({ type: 'list_sessions', ...validatedQuery }) as SessionListPage;
  }

  /** 等待所有已接受请求在 Worker 中处理完成。 */
  public async flush(): Promise<void> {
    if (this.state === 'new' || this.state === 'closed') return;
    await this.enqueue({ type: 'flush' });
  }

  /** 排空并终止 Worker，重复 close 保持幂等。 */
  public close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'new') { this.state = 'closed'; return Promise.resolve(); }
    if (this.state === 'closing') {
      this.closeOperation ??= this.finishClose();
      return this.closeOperation;
    }
    this.state = 'closing';
    this.closeOperation = this.finishClose();
    return this.closeOperation;
  }

  /** 执行一次真实关闭，保证并发 close 调用共享同一个完成 Promise。 */
  private async finishClose(): Promise<void> {
    if (!this.workerFailed) {
      try { await this.enqueue({ type: 'flush' }); } catch { /* 关闭时保留首个持久化故障并继续释放资源。 */ }
    }
    await this.closeWorker();
    this.state = 'closed';
  }

  /** 将请求加入有界 Worker 队列。 */
  private enqueue(request: Omit<WorkerRequest, 'id'>): Promise<unknown> {
    if (this.state !== 'open' && !(this.state === 'new' && request.type === 'ready') && !(this.state === 'closing' && request.type === 'flush')) {
      throw new SqlitePersistenceError(this.state === 'closed' || this.state === 'closing' ? 'provider_closed' : 'provider_not_open', 'Provider 尚未可用');
    }
    // flush 是排空命令，队列满时仍必须能够进入队尾，否则关闭无法释放已接受的写入。
    if (this.pending.size >= this.queueCapacity && request.type !== 'flush') return Promise.reject(new SqlitePersistenceError('provider_queue_full', 'Provider 异步队列已满'));
    const worker = this.worker;
    if (!worker) return Promise.reject(new SqlitePersistenceError('provider_not_open', 'Provider Worker 未启动'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { worker.postMessage({ ...request, id }); } catch { this.pending.delete(id); reject(new SqlitePersistenceError('provider_worker_failed', 'Worker 请求失败')); }
    });
  }

  /** 处理 Worker 的成功或稳定错误响应。 */
  private handleResponse(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new SqlitePersistenceError(mapWorkerCode(response.error.code), response.error.message));
  }

  /** Worker 故障时拒绝所有未完成操作，禁止调用方永久等待。 */
  private handleWorkerFailure(_error: unknown): void {
    if (this.state === 'closed') return;
    for (const pending of this.pending.values()) pending.reject(new SqlitePersistenceError('provider_worker_failed', 'SQLite Worker 失败'));
    this.pending.clear();
    this.workerFailed = true;
    if (this.state === 'open') this.state = 'closing';
  }

  /** 尽力终止 Worker，并释放尚未完成请求。 */
  private async closeWorker(): Promise<void> {
    for (const pending of this.pending.values()) pending.reject(new SqlitePersistenceError('provider_closed', 'Provider 已关闭'));
    this.pending.clear();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}

/** 标准 Provider 模块导出，供 Registry 或外部宿主注册。 */
export const sqlitePersistenceProviderModule: PersistenceProviderModule = {
  manifest: SQLITE_MANIFEST,
  createProvider: (() => new SqlitePersistenceProvider()) satisfies PersistenceProviderFactory
};

/** 解析并限制 SQLite Provider 配置。 */
function parseOptions(options: PersistenceProviderOptions): { filename: string; queueCapacity: number } {
  if (options === undefined) return { filename: ':memory:', queueCapacity: DEFAULT_QUEUE_CAPACITY };
  if (!isRecord(options)) throw new SqlitePersistenceError('provider_config_invalid', 'SQLite Provider 配置必须是对象');
  const filename = options.filename === undefined ? ':memory:' : options.filename;
  const queueCapacity = options.queueCapacity === undefined ? DEFAULT_QUEUE_CAPACITY : options.queueCapacity;
  if (typeof filename !== 'string' || filename.trim().length === 0 || typeof queueCapacity !== 'number' || !Number.isSafeInteger(queueCapacity) || queueCapacity <= 0 || queueCapacity > 4096) throw new SqlitePersistenceError('provider_config_invalid', 'SQLite Provider 配置无效');
  return { filename, queueCapacity };
}

/** 校验消息进入持久化边界前的最小结构。 */
function validateMessage(message: SessionMessage): void {
  if (!message || !['user', 'assistant', 'system'].includes(message.role) || typeof message.messageId !== 'string' || message.messageId.length === 0 || typeof message.content !== 'string' || typeof message.occurredAt !== 'string') throw new SqlitePersistenceError('message_invalid', '消息格式无效');
}

/** 校验会话查询标识。 */
function validateSessionId(sessionId: string): void {
  validateSessionIdentity({ sessionId, runId: 'read' });
}

/** 校验并复制最近消息查询参数，转换为 SQLite Provider 的稳定错误。 */
function normalizeMessageQuery(query: RecentMessageQuery | undefined): RecentMessageQuery | undefined {
  if (query === undefined) return undefined;
  try {
    return validateRecentMessageQuery(query);
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw new SqlitePersistenceError('message_query_invalid', '最近消息查询参数无效');
    throw error;
  }
}

/** 校验并复制会话摘要分页参数，转换为 SQLite Provider 的稳定错误。 */
function normalizeSessionListQuery(query: SessionListQuery | undefined): Required<Pick<SessionListQuery, 'limit'>> & Pick<SessionListQuery, 'cursor'> {
  try {
    return validateSessionListQuery(query);
  } catch (error) {
    if (error instanceof PersistenceValidationError) throw new SqlitePersistenceError('session_list_query_invalid', '会话摘要查询参数无效');
    throw error;
  }
}

/** 判断 Provider 配置是否为对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将 Worker 返回的错误码收敛到 Provider 公开错误集合。 */
function mapWorkerCode(code: string): SqlitePersistenceError['code'] {
  if (code === 'message_id_conflict' || code === 'event_id_conflict' || code === 'snapshot_revision_conflict' || code === 'session_list_query_invalid') return code;
  return 'sqlite_failure';
}
