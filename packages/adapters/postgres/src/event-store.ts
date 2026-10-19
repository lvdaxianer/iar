/**
 * 提供带租户 SQL 条件的 PostgreSQL EventStore。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { EventEnvelope } from '@iar/contracts';
import { StorageConflictError, type EventStore } from '@iar/storage';
import { assertIdentifier, cloneEvent } from './serialization.js';
import { mapPostgresConflict, querySafely, withTransaction } from './transaction.js';
import type { PostgresQueryClient } from './types.js';

/** PostgreSQL 事件行的最小返回字段。 */
type EventRow = { payload: EventEnvelope };

/** 租户绑定的 PostgreSQL 事件事实源。 */
export class PostgresEventStore implements EventStore {
  /**
   * 创建只使用固定 tenantId 的事件存储。
   *
   * @param client - PostgreSQL 连接池边界
   * @param tenantId - 已绑定的租户标识
   * @param readyPromise - schema 初始化完成信号
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(
    private readonly client: PostgresQueryClient,
    private readonly tenantId: string,
    private readonly readyPromise: Promise<void>
  ) {}

  /**
   * 追加一个不可变事件。
   *
   * @param event - 待持久化的事件事实
   * @returns 事件写入完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async append(event: EventEnvelope): Promise<void> {
    const clonedEvent = cloneEvent(event);
    await this.readyPromise;
    try {
      await this.client.query(
        'INSERT INTO iar_events (tenant_id, event_id, run_id, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [this.tenantId, clonedEvent.eventId, clonedEvent.runId, JSON.stringify(clonedEvent)]
      );
    } catch (error) {
      throw mapPostgresConflict(error, clonedEvent.eventId);
    }
  }

  /**
   * 在单个参数化 INSERT 中原子追加事件批次。
   *
   * @param events - 按事件顺序排列的事实批次
   * @returns 批量写入完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async appendAll(events: readonly EventEnvelope[]): Promise<void> {
    if (events.length === 0) return;
    const clonedEvents = events.map(cloneEvent);
    assertDistinctEventIds(clonedEvents);
    await this.readyPromise;
    const values = clonedEvents.flatMap((event) => [this.tenantId, event.eventId, event.runId, JSON.stringify(event)]);
    const placeholders = clonedEvents.map((_, index) => {
      const offset = index * 4;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}::jsonb)`;
    }).join(', ');
    try {
      await withTransaction(this.client, (connection) => querySafely(
        connection,
        `INSERT INTO iar_events (tenant_id, event_id, run_id, payload) VALUES ${placeholders}`,
        values
      ).then(() => undefined));
    } catch (error) {
      throw mapPostgresConflict(error, '批量事件');
    }
  }

  /**
   * 按 PostgreSQL sequence 返回当前租户的事件。
   *
   * @param runId - 可选的运行范围
   * @returns 与数据库引用隔离的事件快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async list(runId?: string): Promise<EventEnvelope[]> {
    if (runId !== undefined) assertIdentifier(runId, 'runId');
    await this.readyPromise;
    const result = runId === undefined
      ? await querySafely<EventRow>(this.client, 'SELECT payload FROM iar_events WHERE tenant_id = $1 ORDER BY sequence', [this.tenantId])
      : await querySafely<EventRow>(this.client, 'SELECT payload FROM iar_events WHERE tenant_id = $1 AND run_id = $2 ORDER BY sequence', [this.tenantId, runId]);
    return result.rows.map((row) => cloneEvent(row.payload));
  }

  /**
   * 查询当前租户的单个事件。
   *
   * @param eventId - 事件唯一标识
   * @returns 事件快照或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async get(eventId: string): Promise<EventEnvelope | undefined> {
    assertIdentifier(eventId, 'eventId');
    await this.readyPromise;
    const result = await querySafely<EventRow>(this.client,
      'SELECT payload FROM iar_events WHERE tenant_id = $1 AND event_id = $2',
      [this.tenantId, eventId]
    );
    return result.rows[0] ? cloneEvent(result.rows[0].payload) : undefined;
  }
}

/**
 * 批量写入前拒绝重复事件 ID，避免数据库往返后才发现输入错误。
 *
 * @param events - 已完成契约校验的事件批次
 * @returns 无返回值；重复时抛出稳定冲突错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDistinctEventIds(events: readonly EventEnvelope[]): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new StorageConflictError(`事件已存在: ${event.eventId}`);
    ids.add(event.eventId);
  }
}
