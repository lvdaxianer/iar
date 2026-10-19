/**
 * 提供独立 SQLite 工作线程、有界队列和版本保护的异步快照存储。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import { Worker } from 'node:worker_threads';
import { cloneSnapshot } from './json.js';
import {
  StorageConflictError,
  StoragePersistenceError,
  StorageValidationError,
  type SnapshotRecord,
  type SnapshotStore
} from './types.js';
import type {
  SnapshotWorkerError,
  SnapshotWorkerRequest,
  SnapshotWorkerResponse
} from './async-sqlite-snapshot-worker.js';

/** 异步快照存储配置。 */
export type AsyncSqliteSnapshotStoreOptions = {
  filename: string;
  maxQueue?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  writeDelayMs?: number;
};

type StoreState = 'open' | 'closing' | 'failed' | 'closed';
type OperationResult = SnapshotRecord | undefined;
type SnapshotWorkerInput =
  | { type: 'save'; snapshot: SnapshotRecord }
  | { type: 'get'; runId: string }
  | { type: 'delete'; runId: string };
type PendingOperation = {
  request: SnapshotWorkerRequest;
  resolve: (result: OperationResult) => void;
  reject: (error: Error) => void;
  attempts: number;
};

const DEFAULT_MAX_QUEUE = 128;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_WRITE_DELAY_MS = 0;
const MIN_NON_NEGATIVE = 0;
const FIRST_OPERATION_ID = 1;
const MAX_OPERATION_ID = Number.MAX_SAFE_INTEGER;
const WORKER_ERROR_CODES = ['snapshot_revision_conflict', 'snapshot_invalid', 'snapshot_persistence_failed'] as const;

/** SQLite 异步快照存储，所有 DatabaseSync 调用均发生在工作线程。 */
export class AsyncSqliteSnapshotStore implements SnapshotStore {
  private readonly worker: Worker;
  private readonly options: Required<Omit<AsyncSqliteSnapshotStoreOptions, 'filename'>> & Pick<AsyncSqliteSnapshotStoreOptions, 'filename'>;
  private readonly queue: PendingOperation[] = [];
  private readonly pending = new Map<number, PendingOperation>();
  private readonly drainWaiters: Array<() => void> = [];
  private state: StoreState = 'open';
  private ready = false;
  private inFlight: PendingOperation | undefined;
  private nextOperationId = FIRST_OPERATION_ID;
  private terminating = false;
  private closePromise: Promise<void> | undefined;

  /** 创建工作线程并等待其异步 ready 消息。 */
  public constructor(options: AsyncSqliteSnapshotStoreOptions) {
    this.options = normalizeOptions(options);
    this.worker = new Worker(new URL('./async-sqlite-snapshot-worker.js', import.meta.url), {
      workerData: { filename: this.options.filename, writeDelayMs: this.options.writeDelayMs },
      // 测试运行器会把不可传递的 V8 参数放入 execArgv，工作线程使用默认运行参数。
      execArgv: []
    });
    this.worker.on('message', (message: SnapshotWorkerResponse) => this.handleMessage(message));
    this.worker.on('error', () => this.failAll('snapshot_worker_failed'));
    this.worker.on('exit', () => this.handleExit());
  }

  /** 校验、复制并异步入队一个不可变快照。 */
  public async save(snapshot: SnapshotRecord): Promise<void> {
    const cloned = cloneSnapshot(snapshot);
    await this.enqueue({ type: 'save', snapshot: cloned });
  }

  /** 按消息顺序读取一个会话的最新有效快照。 */
  public async get(runId: string): Promise<SnapshotRecord | undefined> {
    return this.enqueue({ type: 'get', runId });
  }

  /** 按消息顺序删除一个会话快照。 */
  public async delete(runId: string): Promise<void> {
    await this.enqueue({ type: 'delete', runId });
  }

  /** 等待当前已接受的工作全部完成，不关闭存储。 */
  public async drain(): Promise<void> {
    if (this.pending.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  /** 正常排空队列后终止工作线程；重复调用保持幂等。 */
  public async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = this.state === 'open' ? 'closing' : this.state;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  /** 关闭前排空已接受消息并回收工作线程。 */
  private async finishClose(): Promise<void> {
    await this.drain();
    this.terminating = true;
    await this.worker.terminate();
    this.state = 'closed';
  }

  /** 校验生命周期和队列容量后登记一条操作。 */
  private enqueue(request: SnapshotWorkerInput): Promise<OperationResult> {
    if (this.state === 'closed' || this.state === 'closing') return Promise.reject(new StoragePersistenceError('snapshot_store_closed'));
    if (this.state === 'failed') return Promise.reject(new StoragePersistenceError('snapshot_worker_failed'));
    if (this.pending.size >= this.options.maxQueue) return Promise.reject(new StoragePersistenceError('snapshot_queue_full'));
    const id = this.allocateOperationId();
    return new Promise<OperationResult>((resolve, reject) => {
      const operation: PendingOperation = { request: { ...request, id }, resolve, reject, attempts: 0 };
      this.pending.set(id, operation);
      this.queue.push(operation);
      this.pump();
    });
  }

  /** 分配不会与未完成消息冲突的操作 ID。 */
  private allocateOperationId(): number {
    const id = this.nextOperationId;
    this.nextOperationId = id === MAX_OPERATION_ID ? FIRST_OPERATION_ID : id + 1;
    return id;
  }

  /** 工作线程 ready 后逐条发送，保证实例内消息顺序。 */
  private pump(): void {
    if (!this.ready || this.inFlight || this.queue.length === 0 || this.state === 'failed' || this.state === 'closed') return;
    const operation = this.queue.shift();
    if (!operation) return;
    this.inFlight = operation;
    try {
      this.worker.postMessage(operation.request);
    } catch {
      this.failAll('snapshot_worker_failed');
    }
  }

  /** 处理工作线程启动、响应和 fatal 协议消息。 */
  private handleMessage(message: unknown): void {
    if (!isWorkerResponse(message)) {
      this.failAll('snapshot_worker_failed');
      return;
    }
    if (message.type === 'ready') {
      // ready 表示工作线程已完成 SQLite 初始化，可以开始泵送队列。
      this.ready = true;
      this.pump();
    } else if (message.type === 'fatal') {
      // fatal 只携带白名单错误码，所有已接受操作统一失败。
      this.failAll(message.error.code);
    } else if (message.type === 'response') {
      // response 必须匹配当前唯一 in-flight 消息，否则视为协议损坏。
      this.handleResponse(message);
    } else {
      // 类型守卫已覆盖合法分支，保留 fail-closed 防御路径。
      this.failAll('snapshot_worker_failed');
    }
  }

  /** 校验响应对应当前操作，并决定成功、重试或稳定失败。 */
  private handleResponse(message: Extract<SnapshotWorkerResponse, { type: 'response' }>): void {
    const operation = this.pending.get(message.id);
    if (!operation || operation !== this.inFlight) {
      this.failAll('snapshot_worker_failed');
      return;
    }
    if (message.ok && this.complete(message.id, message.result)) return;
    if (!message.ok && this.retry(operation, message.error)) return;
    this.complete(message.id, undefined, message.ok ? undefined : toStorageError(message.error));
  }

  /** 对可恢复的持久化错误执行有限重试，并阻塞后续消息。 */
  private retry(operation: PendingOperation, error: SnapshotWorkerError): boolean {
    if (error.kind !== 'persistence' || operation.attempts >= this.options.maxRetries) return false;
    operation.attempts += 1;
    setTimeout(() => {
      if (this.state === 'failed' || this.state === 'closed') return;
      try {
        this.worker.postMessage(operation.request);
      } catch {
        this.failAll('snapshot_worker_failed');
      }
    }, this.options.retryDelayMs);
    return true;
  }

  /** 完成操作、推进队列并唤醒 drain 调用方。 */
  private complete(id: number, result?: OperationResult, error?: Error): boolean {
    const operation = this.pending.get(id);
    if (!operation) return false;
    this.pending.delete(id);
    this.inFlight = undefined;
    if (error) operation.reject(error);
    else operation.resolve(result);
    this.pump();
    this.notifyDrain();
    return true;
  }

  /** 工作线程异常退出时让所有已接受消息稳定失败。 */
  private handleExit(): void {
    if (this.terminating || this.state === 'closed') return;
    this.failAll('snapshot_worker_failed');
  }

  /** 清空队列并拒绝所有 pending，避免调用方永久等待。 */
  private failAll(code: string): void {
    if (this.state !== 'closed') this.state = 'failed';
    const error = new StoragePersistenceError(code);
    const operations = [...this.pending.values()];
    this.queue.length = 0;
    this.inFlight = undefined;
    this.pending.clear();
    operations.forEach((operation) => operation.reject(error));
    this.notifyDrain();
  }

  /** drain 在队列和当前操作均为空时立即完成。 */
  private notifyDrain(): void {
    if (this.pending.size !== 0) return;
    const waiters = this.drainWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
  }
}

/** 规范化配置并拒绝无界或非法的生命周期参数。 */
function normalizeOptions(options: AsyncSqliteSnapshotStoreOptions): Required<Omit<AsyncSqliteSnapshotStoreOptions, 'filename'>> & Pick<AsyncSqliteSnapshotStoreOptions, 'filename'> {
  if (!options.filename) throw new StorageValidationError('SQLite filename 无效');
  const normalized = {
    filename: options.filename,
    maxQueue: options.maxQueue ?? DEFAULT_MAX_QUEUE,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    writeDelayMs: options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
  };
  if (!Number.isSafeInteger(normalized.maxQueue) || normalized.maxQueue <= MIN_NON_NEGATIVE) throw new StorageValidationError('maxQueue 必须是正整数');
  if (!Number.isSafeInteger(normalized.maxRetries) || normalized.maxRetries < MIN_NON_NEGATIVE) throw new StorageValidationError('maxRetries 必须是非负整数');
  if (!Number.isSafeInteger(normalized.retryDelayMs) || normalized.retryDelayMs < MIN_NON_NEGATIVE) throw new StorageValidationError('retryDelayMs 必须是非负整数');
  if (!Number.isSafeInteger(normalized.writeDelayMs) || normalized.writeDelayMs < MIN_NON_NEGATIVE) throw new StorageValidationError('writeDelayMs 必须是非负整数');
  return normalized;
}

/** 将工作线程错误映射为公开的稳定存储错误。 */
function toStorageError(error: SnapshotWorkerError): Error {
  if (error.kind === 'conflict') return new StorageConflictError('snapshot_revision_conflict');
  if (error.kind === 'validation') return new StorageValidationError('snapshot_invalid');
  return new StoragePersistenceError('snapshot_persistence_failed');
}

/** 判断未知对象是否为工作线程稳定错误。 */
function isWorkerError(value: unknown): value is SnapshotWorkerError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.kind === 'conflict' || candidate.kind === 'validation' || candidate.kind === 'persistence')
    && typeof candidate.code === 'string' && WORKER_ERROR_CODES.includes(candidate.code as typeof WORKER_ERROR_CODES[number]);
}

/** 判断未知消息是否满足工作线程协议，拒绝任意未白名单字段。 */
function isWorkerResponse(value: unknown): value is SnapshotWorkerResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'ready') return true;
  if (candidate.type === 'fatal') return isWorkerError(candidate.error);
  if (candidate.type !== 'response' || !Number.isSafeInteger(candidate.id)) return false;
  if (candidate.ok === true) return candidate.result === undefined || (typeof candidate.result === 'object' && candidate.result !== null);
  return candidate.ok === false && isWorkerError(candidate.error);
}
