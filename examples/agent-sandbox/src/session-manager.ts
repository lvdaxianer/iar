/**
 * 管理隔离会话、有界请求队列和空闲资源。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomBytes } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { IarSandboxSession, type SandboxMode } from './session.js';
import type { SnapshotStore } from '@iar/storage';
import type { SessionListPage, SessionListQuery, SessionPersistenceProvider } from '@iar/persistence-spi';

/** 会话管理可配置上限；包含正在执行的请求。 */
/** 每个节点单独记录开始和取消状态，避免重复释放容量。 */
export type SandboxSessionLimits = { maxSessions?: number; idleMs?: number; maxPending?: number; maxOperations?: number };
type Entry = { session: IarSandboxSession; ready: Promise<void> | undefined; queue: QueueNode[]; active: QueueNode | undefined; pending: number; operations: number; confirmations: Set<string>; lastUsed: number; closing: boolean };
type QueueNode = { isDeleting: boolean; isStarted: boolean; isCancelled: boolean; action?: () => Promise<unknown>; result: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
export type Operation = 'read' | 'mutate' | 'confirm' | 'cancel' | 'reset' | 'delete' | { kind: 'confirm' | 'cancel'; actionId: unknown; accepted?: unknown };
type Reservation = { run: <T>(operation: Operation, action: (session: IarSandboxSession) => Promise<T>) => Promise<T>; cancel: () => void };
const DEFAULT_LIMITS = { maxSessions: 32, idleMs: 30 * 60_000, maxPending: 16, maxOperations: 128 };
const ID_BYTES = 24;
/** 确认标识的最大长度，避免无界请求字段。 */
const MAX_ACTION_ID_LENGTH = 256;

/** 稳定的客户端错误，不包含请求数据或会话标识。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SessionError extends Error {
  /** @param status - HTTP 状态码 @param reasonCode - 固定错误码 @author lvdaxianer@yeah.net @date 2026-10-18 */
  public constructor(public readonly status: number, public readonly reasonCode: string) { super(reasonCode); }
}

/**
 * 管理默认兼容会话和通过随机标识访问的独立会话。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionManager {
  private readonly entries = new Map<string, Entry>();
  /** 已移出索引但删除操作尚未完成的条目仍须参与排空。 */
  private readonly retired = new Set<Entry>();
  private readonly legacy: Entry;
  private readonly limits: Required<SandboxSessionLimits>;
  private readonly timer: NodeJS.Timeout;
  private readonly restoring = new Map<string, Promise<void>>();

  /** 初始化限制与空闲清理定时器，兼容会话由服务持有。
   * @param mode - 会话运行模式 @param session - 兼容会话 @param limits - 资源上限
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public constructor(private readonly mode: SandboxMode, session: IarSandboxSession, limits: SandboxSessionLimits = {}, private readonly snapshotStore?: SnapshotStore, private readonly persistenceProvider?: SessionPersistenceProvider, private readonly persistenceProviderOpened = false) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid session limits');
    this.legacy = this.createEntry(session);
    this.timer = setInterval(() => this.sweep(), Math.min(this.limits.idleMs, 60_000));
    this.timer.unref();
  }

  /** 新建不可猜测标识及独立会话；满载时不驱逐现有会话。
   * @returns 新会话标识 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public create(): string {
    this.sweep();
    if (this.entries.size >= this.limits.maxSessions) throw new SessionError(503, 'session_capacity');
    const id = randomBytes(ID_BYTES).toString('base64url');
    const sessionOptions = this.sessionOptions(id);
    this.entries.set(id, this.createEntry(new IarSandboxSession(sessionOptions)));
    return id;
  }

  /** 通过持久化快照恢复一个已知会话，供服务重启后的显式恢复入口使用。 */
  public async restore(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new SessionError(400, 'invalid_session_id');
    if (this.entries.has(id)) return;
    if (!this.snapshotStore && !this.persistenceProvider) throw new SessionError(404, 'session_not_found');
    const existing = this.restoring.get(id);
    if (existing) return existing;
    const operation = this.restoreEntry(id);
    this.restoring.set(id, operation);
    try { await operation; } finally { this.restoring.delete(id); }
  }

  /** 查询持久化会话的轻量摘要；无 Provider 时保持内存模式兼容并返回空页。 */
  public async listSessions(query?: SessionListQuery): Promise<SessionListPage> {
    if (!this.persistenceProvider) return { sessions: [] };
    return this.persistenceProvider.listSessions(query);
  }

  /** 读取快照并等待新会话完成恢复，失败时不把半初始化条目放入索引。 */
  private async restoreEntry(id: string): Promise<void> {
    const snapshot = await this.persistenceProvider?.loadSnapshot(id) ?? (await this.snapshotStore?.get(id));
    if (!snapshot) throw new SessionError(404, 'session_not_found');
    this.sweep();
    if (this.entries.size >= this.limits.maxSessions) throw new SessionError(503, 'session_capacity');
    const sessionOptions = this.sessionOptions(id);
    const session = new IarSandboxSession(sessionOptions);
    const entry = this.createEntry(session);
    try { if (entry.ready) await entry.ready; } catch { session.dispose(); throw new SessionError(503, 'session_restore_failed'); }
    this.entries.set(id, entry);
  }

  /** 将指定操作加入会话队列，执行和失败均释放队列位置。
   * @param id - 会话标识，省略表示兼容会话 @param operation - 操作类型 @param action - 会话操作
   * @returns 排队操作的结果 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public run<T>(id: string | undefined, operation: Operation, action: (session: IarSandboxSession) => Promise<T>): Promise<T> {
    return this.reserve(id, operation === 'delete').run(operation, action);
  }

  /**
   * 在接收请求头时预约顺序；解析失败或断开可取消尚未开始的预约。
   * 排队容量包括正在处理的请求，避免解析缓慢的请求绕过上限。
   * @param id - 可选的独立会话标识
   * @param isDeleting - 是否预留删除操作
   * @returns 可运行或取消的预约
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public reserve(id: string | undefined, isDeleting = false): Reservation {
    const entry = this.find(id);
    // 满载时立即拒绝，不能无限积累等待任务。
    if (entry.pending >= this.limits.maxPending) throw new SessionError(503, 'session_busy');
    if (isDeleting) entry.closing = true;
    entry.pending += 1;
    const deferred = Promise.withResolvers<unknown>();
    const node: QueueNode = { isDeleting, isStarted: false, isCancelled: false, result: deferred.promise, resolve: deferred.resolve, reject: deferred.reject };
    void node.result.catch(() => undefined);
    entry.queue.push(node);
    return this.createReservation(entry, node);
  }

  /**
   * 创建绑定会话条目的操作句柄，并保持每个请求的异步日志上下文。
   * @param entry - 会话状态与队列
   * @param node - 本次排队节点
   * @returns 预约句柄
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private createReservation(entry: Entry, node: QueueNode): Reservation {
    return {
      run: <T>(operation: Operation, action: (session: IarSandboxSession) => Promise<T>) => {
        // 已取消或重复提交的预约不能再次进入业务逻辑。
        if (node.isCancelled || node.action) return Promise.reject(new SessionError(408, 'request_timeout'));
        node.action = AsyncResource.bind(() => this.execute(entry, operation, action));
        this.advance(entry);
        return node.result as Promise<T>;
      },
      cancel: () => this.cancelReservation(entry, node)
    };
  }

  /**
   * 推进已收到请求体的队首，业务执行期间保持独占。
   * @param entry - 会话状态与队列
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private advance(entry: Entry): void {
    const node = entry.queue[0];
    // 尚有执行任务或队首仍在解析时，后续请求不能越过。
    if (entry.active || !node?.action) return;
    entry.queue.shift(); entry.active = node; node.isStarted = true;
    void Promise.resolve().then(node.action).then(
      (value) => { this.finishReservation(entry); node.resolve(value); },
      (error: unknown) => { this.finishReservation(entry); node.reject(error); }
    );
  }

  /**
   * 先释放容量并推进队列，再向调用方交付操作结果。
   * @param entry - 已完成业务的会话
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private finishReservation(entry: Entry): void {
    entry.active = undefined;
    entry.pending -= 1;
    entry.lastUsed = Date.now();
    // 已删除条目在最后一个预约完成后可从排空集合移除。
    if (entry.pending === 0) this.retired.delete(entry);
    this.advance(entry);
  }

  /**
   * 未开始的请求可移出队列，并立即且仅一次归还容量。
   * @param entry - 会话状态与队列
   * @param node - 待取消节点
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private cancelReservation(entry: Entry, node: QueueNode): void {
    // 已执行或已取消的节点不再归还配额。
    if (node.isStarted || node.isCancelled) return;
    node.isCancelled = true;
    const index = entry.queue.indexOf(node);
    if (index >= 0) entry.queue.splice(index, 1);
    if (node.isDeleting) entry.closing = false;
    entry.pending -= 1; entry.lastUsed = Date.now(); node.resolve(undefined);
    this.advance(entry);
  }

  /** 排队删除独立会话，防止后续请求进入。
   * @param id - 独立会话标识 @returns 删除结束后完成 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public remove(id: string): Promise<void> {
    return this.run(id, 'delete', async (session) => { this.removeReserved(id, session); });
  }

  /**
   * 完成已预约的删除并释放会话线程。
   * @param id - 独立会话标识
   * @param session - 已预约的会话
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public removeReserved(id: string, session: IarSandboxSession): void {
    const entry = this.entries.get(id);
    // 索引移除后保留在途删除，直到结果准备交付。
    if (entry) this.retired.add(entry);
    this.entries.delete(id);
    session.dispose();
    void this.snapshotStore?.delete(id).catch(() => undefined);
  }

  /** 等待所有已接收操作，包括客户端已断开的流式操作。
   * @returns 队列排空后完成 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public async drain(): Promise<void> {
    const entries = [this.legacy, ...this.entries.values(), ...this.retired];
    const queued = entries.flatMap((entry) => [entry.active, ...entry.queue].filter((node): node is QueueNode => node !== undefined).map((node) => node.result.catch(() => undefined)));
    await Promise.all([...queued, ...this.restoring.values()].map((operation) => operation.catch(() => undefined)));
  }

  /** HTTP 队列排空后继续等待每个会话的异步 Hook 和 Provider 写入完成。 */
  public async flushPersistence(): Promise<void> {
    const entries = [this.legacy, ...this.entries.values(), ...this.retired];
    await Promise.all(entries.map((entry) => entry.session.flushPersistence()));
  }

  /** 关闭定时器并释放所有会话；仅在 HTTP 排空后调用。
   * @returns 无返回值 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public dispose(): void {
    clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.session.dispose();
    this.entries.clear();
    this.legacy.session.dispose();
  }

  /** 获取会话并先清理过期的空闲实例。
   * @param id - 可选会话标识 @returns 会话条目 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private find(id: string | undefined): Entry {
    this.sweep();
    const entry = id === undefined ? this.legacy : this.entries.get(id);
    if (!entry || entry.closing) throw new SessionError(404, 'session_not_found');
    return entry;
  }

  /** 执行有界状态操作；重置成功后恢复操作预算。
   * @param entry - 当前会话 @param operation - 操作类型 @param action - 会话操作
   * @returns 操作结果 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private async execute<T>(entry: Entry, operation: Operation, action: (session: IarSandboxSession) => Promise<T>): Promise<T> {
    // 状态读取只读当前内存投影；会话动作和模型决策必须等快照恢复完成。
    if (operation !== 'read' && entry.ready) await entry.ready;
    // 独立确认必须在队首核对当前动作，不能预先判断。
    if (typeof operation === 'object') await this.validateConfirmation(entry, operation);
    const kind = typeof operation === 'string' ? operation : operation.kind;
    // 每次状态操作都计入预算，即使业务随后失败。
    if (kind === 'mutate') {
      if (entry.operations >= this.limits.maxOperations) throw new SessionError(429, 'session_limit');
      entry.operations += 1;
    }
    // 确认预算独立于聊天，最后一轮仍可确认。
    if (kind === 'confirm') await this.consumeConfirmation(entry);
    const result = await action(entry.session);
    // 仅在重置成功后恢复预算。
    if (kind === 'reset') { entry.operations = 0; entry.confirmations.clear(); }
    return result;
  }

  /**
   * 校验客户端看到的动作，禁止过期确认和取消影响新动作。
   * @param entry - 当前会话
   * @param operation - 请求携带的动作标识
   * @returns 校验成功后完成
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async validateConfirmation(entry: Entry, operation: { actionId: unknown; accepted?: unknown }): Promise<void> {
    // 必须明确选择布尔值，不能将非法输入解释为取消。
    if (typeof operation.accepted !== 'boolean') throw new SessionError(400, 'invalid_accepted');
    // 格式错误和状态冲突使用不同固定错误码。
    if (typeof operation.actionId !== 'string' || operation.actionId.length > MAX_ACTION_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(operation.actionId)) throw new SessionError(400, 'invalid_action_id');
    if ((await entry.session.state()).pending?.actionId !== operation.actionId) throw new SessionError(409, 'confirmation_conflict');
  }

  /**
   * 为待确认动作预留唯一一次确认预算。
   * @param entry - 当前会话
   * @returns 预约成功后完成
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async consumeConfirmation(entry: Entry): Promise<void> {
    const pending = (await entry.session.state()).pending;
    // 无待确认动作时保留兼容入口原有错误。
    if (!pending) return;
    if (entry.confirmations.has(pending.actionId) || entry.confirmations.size >= this.limits.maxOperations) throw new SessionError(429, 'session_limit');
    entry.confirmations.add(pending.actionId);
  }

  /** 构造不共享状态与队列的会话条目。
   * @param session - 会话实例 @returns 新条目 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private createEntry(session: IarSandboxSession): Entry {
    const ready = typeof session.whenReady === 'function' ? session.whenReady() : undefined;
    return { session, ready, queue: [], active: undefined, pending: 0, operations: 0, confirmations: new Set(), lastUsed: Date.now(), closing: false };
  }

  /** 为所有独立会话注入同一套可替换持久化依赖，同时保持旧快照接口兼容。 */
  private sessionOptions(id: string): { mode: SandboxMode; sessionId: string; snapshotStore?: SnapshotStore; persistenceProvider?: SessionPersistenceProvider; persistenceProviderOpened?: boolean } {
    return {
      mode: this.mode,
      sessionId: id,
      ...(this.snapshotStore ? { snapshotStore: this.snapshotStore } : {}),
      ...(this.persistenceProvider ? { persistenceProvider: this.persistenceProvider } : {}),
      ...(this.persistenceProviderOpened ? { persistenceProviderOpened: true } : {})
    };
  }

  /** 只回收没有在途或排队操作的过期会话。
   * @returns 无返回值 @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.pending === 0 && now - entry.lastUsed >= this.limits.idleMs) {
        this.entries.delete(id);
        entry.session.dispose();
      }
    }
  }
}
