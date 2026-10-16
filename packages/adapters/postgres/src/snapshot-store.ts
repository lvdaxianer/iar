/**
 * 提供带 revision 保护的 PostgreSQL SnapshotStore。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { BehaviorContext } from '@iar/contracts';
import { StorageConflictError, type SnapshotRecord, type SnapshotStore } from '../../../storage/src/index.js';
import { assertIdentifier, cloneSnapshot, parseContext } from './serialization.js';
import { mapPostgresConflict, querySafely, withTransaction } from './transaction.js';
import type { PostgresQueryClient, PostgresQueryConnection } from './types.js';

/** 快照版本比较所需的数据库字段。 */
type SnapshotVersionRow = { revision: string | number; event_id: string };

/** 快照完整读取所需的数据库字段。 */
type SnapshotRow = SnapshotVersionRow & { run_id: string; context: BehaviorContext };

/** 租户绑定的 PostgreSQL 行为上下文快照。 */
export class PostgresSnapshotStore implements SnapshotStore {
  /**
   * 创建只使用固定 tenantId 的快照存储。
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
   * 在事务内比较 revision 并保存最新快照。
   *
   * @param snapshot - 待保存的行为上下文快照
   * @returns 快照写入完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async save(snapshot: SnapshotRecord): Promise<void> {
    const clonedSnapshot = cloneSnapshot(snapshot);
    await this.readyPromise;
    try {
      await withTransaction(this.client, (connection) => this.saveWithinTransaction(connection, clonedSnapshot));
    } catch (error) {
      throw mapPostgresConflict(error, clonedSnapshot.runId);
    }
  }

  /**
   * 在同一事务连接中完成版本检查和快照写入。
   *
   * @param connection - 已开启事务的专用连接
   * @param snapshot - 已完成 JSON 和版本校验的快照
   * @returns 条件 upsert 完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async saveWithinTransaction(connection: PostgresQueryConnection, snapshot: SnapshotRecord): Promise<void> {
    const current = await querySafely<SnapshotVersionRow>(connection, 'SELECT revision, event_id FROM iar_snapshots WHERE tenant_id = $1 AND run_id = $2 FOR UPDATE', [this.tenantId, snapshot.runId]);
    assertSnapshotRevision(current.rows[0], snapshot);
    const result = await querySafely<SnapshotVersionRow>(connection, `INSERT INTO iar_snapshots (tenant_id, run_id, event_id, revision, context)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (tenant_id, run_id) DO UPDATE SET event_id = EXCLUDED.event_id, revision = EXCLUDED.revision, context = EXCLUDED.context
      WHERE EXCLUDED.revision > iar_snapshots.revision
         OR (EXCLUDED.revision = iar_snapshots.revision AND EXCLUDED.event_id = iar_snapshots.event_id)
      RETURNING revision, event_id`, [this.tenantId, snapshot.runId, snapshot.eventId, snapshot.revision, JSON.stringify(snapshot.context)]);
    // returning 行表示本次 insert/update 已经通过 revision 条件。
    if (result.rows.length > 0) return;
    const latest = await querySafely<SnapshotVersionRow>(connection, 'SELECT revision, event_id FROM iar_snapshots WHERE tenant_id = $1 AND run_id = $2 FOR UPDATE', [this.tenantId, snapshot.runId]);
    assertSnapshotRevision(latest.rows[0], snapshot);
    // 无 returning 行表示竞争事务留下了更高或不同 eventId 的版本。
    throw new StorageConflictError(`快照版本冲突: ${snapshot.runId}`);
  }

  /**
   * 读取当前租户的最新快照。
   *
   * @param runId - 运行唯一标识
   * @returns 快照副本或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async get(runId: string): Promise<SnapshotRecord | undefined> {
    assertIdentifier(runId, 'runId');
    await this.readyPromise;
    const result = await querySafely<SnapshotRow>(this.client,
      'SELECT run_id, event_id, revision, context FROM iar_snapshots WHERE tenant_id = $1 AND run_id = $2',
      [this.tenantId, runId]
    );
    const row = result.rows[0];
    return row ? cloneSnapshot({ runId: row.run_id, eventId: row.event_id, revision: Number(row.revision), context: parseContext(row.context) }) : undefined;
  }

  /**
   * 删除当前租户的运行快照。
   *
   * @param runId - 运行唯一标识
   * @returns 删除完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async delete(runId: string): Promise<void> {
    assertIdentifier(runId, 'runId');
    await this.readyPromise;
    await querySafely(this.client, 'DELETE FROM iar_snapshots WHERE tenant_id = $1 AND run_id = $2', [this.tenantId, runId]);
  }
}

/**
 * 拒绝旧 revision 或同版本不同事件覆盖当前快照。
 *
 * @param current - 数据库中锁定的当前版本
 * @param snapshot - 请求写入的快照
 * @returns 无返回值；不满足单调版本时抛出冲突
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertSnapshotRevision(current: SnapshotVersionRow | undefined, snapshot: SnapshotRecord): void {
  // 没有当前行是首次写入，最终是否竞争成功由条件 upsert 决定。
  if (!current) return;
  // 数据库 revision 可能以字符串返回，先转换后再做数值比较。
  const currentRevision = Number(current.revision);
  // 更旧 revision 不能覆盖事实源当前视图。
  if (snapshot.revision < currentRevision) throw new StorageConflictError(`快照版本回退: ${snapshot.runId}`);
  // 同版本必须指向相同事实事件，否则会产生不可重放分叉。
  if (snapshot.revision === currentRevision && current.event_id !== snapshot.eventId) {
    throw new StorageConflictError(`快照版本冲突: ${snapshot.runId}`);
  }
  // 更高版本或同事件同版本允许继续进入条件 upsert。
}
