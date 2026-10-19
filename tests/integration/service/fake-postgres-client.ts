/**
 * 提供 Phase 4.1 的确定性 PostgreSQL 查询客户端测试替身。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { BehaviorContext, EventEnvelope } from '@iar/contracts';
import type { PostgresQueryClient } from '@iar/adapters-postgres';

/*
 * Fake 只模拟参数化 SQL、租户过滤、事务回滚和连接释放；pg-mem 负责方言执行。
 * 未覆盖的 SQL、重复键和驱动故障都 fail-fast，确保安全边界能离线重复验证。
 */

/** fake client 的事件行。 */
type FakeEventRow = { tenantId: string; eventId: string; runId: string; sequence: number; payload: EventEnvelope };

/** fake client 的快照行。 */
type FakeSnapshotRow = { tenantId: string; runId: string; eventId: string; revision: number; context: BehaviorContext };

/** fake client 的注册行。 */
type FakeRegistryRow = { tenantId: string; key: string; value: Record<string, unknown> };

/** 用最小查询客户端模拟 PostgreSQL 参数化接口。 */
export class FakePostgresClient implements PostgresQueryClient {
  public readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  public failBegin = false;
  public releaseCount = 0;
  private readonly events = new Map<string, FakeEventRow>();
  private readonly snapshots = new Map<string, FakeSnapshotRow>();
  private readonly registry = new Map<string, FakeRegistryRow>();
  private sequence = 0;
  private backup: { events: Map<string, FakeEventRow>; snapshots: Map<string, FakeSnapshotRow>; registry: Map<string, FakeRegistryRow>; sequence: number } | undefined;

  /**
   * 返回当前 fake 连接，验证事务操作不会切换客户端实例。
   *
   * @returns 当前 fake 作为事务连接
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async connect(): Promise<FakePostgresClient> {
    return this;
  }

  /**
   * fake 连接不需要归还真实资源，但记录释放次数。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public release(): void {
    this.releaseCount += 1;
  }

  /**
   * 保存查询记录并分发到一个受限的 SQL 行为。
   *
   * @param text - 待执行的 SQL 文本
   * @param values - SQL 参数数组
   * @returns fake 查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: Row[]; rowCount: number }> {
    this.queries.push({ text, values });
    const sql = text.replaceAll(/\s+/g, ' ').trim();
    if (sql === 'BEGIN' && this.failBegin) throw new Error('secret begin failure');
    return this.dispatchQuery<Row>(sql, values);
  }

  /**
   * 将 SQL 前缀映射到测试用例需要的固定行为。
   *
   * @param sql - 标准化后的 SQL 文本
   * @param values - SQL 参数数组
   * @returns fake 查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private dispatchQuery<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    // DDL 是幂等启动语句，fake 只记录其执行而不模拟系统目录。
    if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) return this.result<Row>([], 0);
    // 事务控制语句必须走同一 fake 连接，以覆盖连接池生命周期。
    if (sql === 'BEGIN') return this.begin<Row>();
    if (sql === 'COMMIT') return this.commit<Row>();
    if (sql === 'ROLLBACK') return this.rollback<Row>();
    // 事件写入和读取分别覆盖批量追加、run 查询和 event 查询。
    if (sql.startsWith('INSERT INTO iar_events')) return this.insertEvents<Row>(values);
    if (sql.startsWith('SELECT payload FROM iar_events')) return this.selectEvents<Row>(sql, values);
    // 快照查询与条件 upsert 覆盖 revision 单调和并发写入。
    if (sql.startsWith('SELECT revision, event_id FROM iar_snapshots')) return this.selectSnapshotVersion<Row>(values);
    if (sql.startsWith('INSERT INTO iar_snapshots')) return this.insertSnapshot<Row>(values);
    if (sql.startsWith('SELECT run_id, event_id, revision, context FROM iar_snapshots')) return this.selectSnapshot<Row>(values);
    if (sql.startsWith('DELETE FROM iar_snapshots')) return this.deleteSnapshot<Row>(values);
    // 注册表分别模拟覆盖写、幂等首次写入、单项读取和列表读取。
    if (sql.startsWith('INSERT INTO iar_registry')) return this.insertRegistry<Row>(sql, values);
    if (sql.startsWith('SELECT key, value FROM iar_registry') || sql.startsWith('SELECT key FROM iar_registry')) return this.selectRegistry<Row>(sql, values);
    if (sql.startsWith('DELETE FROM iar_registry')) return this.deleteRegistry<Row>(values);
    // 未覆盖的 SQL 立即失败，避免测试掩盖生产查询变化。
    throw new Error(`fake client received unsupported SQL: ${sql}`);
  }

  /**
   * 开启事务快照，支持测试批量写入回滚。
   *
   * @returns 空查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private begin<Row extends Record<string, unknown>>(): { rows: Row[]; rowCount: number } {
    this.backup = { events: structuredClone(this.events), snapshots: structuredClone(this.snapshots), registry: structuredClone(this.registry), sequence: this.sequence };
    return this.result<Row>([], 0);
  }

  /**
   * 提交事务并丢弃回滚快照。
   *
   * @returns 空查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private commit<Row extends Record<string, unknown>>(): { rows: Row[]; rowCount: number } {
    this.backup = undefined;
    return this.result<Row>([], 0);
  }

  /**
   * 回滚事务状态。
   *
   * @returns 空查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private rollback<Row extends Record<string, unknown>>(): { rows: Row[]; rowCount: number } {
    if (this.backup) {
      this.replaceMap(this.events, this.backup.events);
      this.replaceMap(this.snapshots, this.backup.snapshots);
      this.replaceMap(this.registry, this.backup.registry);
      this.sequence = this.backup.sequence;
      this.backup = undefined;
    }
    return this.result<Row>([], 0);
  }

  /**
   * 写入一个或多个事件行，并模拟唯一约束。
   *
   * @param values - 以四个参数为一组的事件写入参数
   * @returns fake 写入结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private insertEvents<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const rows = values.length / 4;
    const pending = Array.from({ length: rows }, (_, index) => {
      const offset = index * 4;
      return { tenantId: String(values[offset]), eventId: String(values[offset + 1]), runId: String(values[offset + 2]), payload: JSON.parse(String(values[offset + 3])) as EventEnvelope };
    });
    if (pending.some((row) => this.events.has(`${row.tenantId}:${row.eventId}`))) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    pending.forEach((row) => this.events.set(`${row.tenantId}:${row.eventId}`, { ...row, sequence: ++this.sequence }));
    return this.result<Row>([], pending.length);
  }

  /**
   * 按 tenant、run 或 event 读取事件。
   *
   * @param sql - 用于区分读取范围的标准化 SQL
   * @param values - tenant、run 或 event 参数
   * @returns fake 事件查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private selectEvents<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const tenantId = String(values[0]);
    const candidates = [...this.events.values()].filter((row) => row.tenantId === tenantId);
    const rows = sql.includes('run_id = $2')
      ? candidates.filter((row) => row.runId === String(values[1]))
      : sql.includes('event_id = $2')
        ? candidates.filter((row) => row.eventId === String(values[1]))
        : candidates.sort((left, right) => left.sequence - right.sequence);
    return this.result<Row>(rows.map((row) => ({ payload: row.payload })), rows.length);
  }

  /**
   * 读取快照的 revision 和 eventId。
   *
   * @param values - tenantId 和 runId 参数
   * @returns fake 快照版本查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private selectSnapshotVersion<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const row = this.snapshots.get(`${String(values[0])}:${String(values[1])}`);
    return this.result<Row>(row ? [{ revision: row.revision, event_id: row.eventId }] : [], row ? 1 : 0);
  }

  /**
   * 插入或更新快照，并模拟条件 upsert 的 returning 行。
   *
   * @param values - tenant、run、event、revision 和 context 参数
   * @returns fake 条件 upsert 结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private insertSnapshot<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const row = { tenantId: String(values[0]), runId: String(values[1]), eventId: String(values[2]), revision: Number(values[3]), context: JSON.parse(String(values[4])) as BehaviorContext };
    const existing = this.snapshots.get(`${row.tenantId}:${row.runId}`);
    if (existing && (row.revision < existing.revision || (row.revision === existing.revision && row.eventId !== existing.eventId))) return this.result<Row>([], 0);
    this.snapshots.set(`${row.tenantId}:${row.runId}`, row);
    return this.result<Row>([{ revision: row.revision, event_id: row.eventId }], 1);
  }

  /**
   * 读取完整快照。
   *
   * @param values - tenantId 和 runId 参数
   * @returns fake 快照查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private selectSnapshot<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const row = this.snapshots.get(`${String(values[0])}:${String(values[1])}`);
    return this.result<Row>(row ? [{ run_id: row.runId, event_id: row.eventId, revision: row.revision, context: row.context }] : [], row ? 1 : 0);
  }

  /**
   * 删除快照。
   *
   * @param values - tenantId 和 runId 参数
   * @returns fake 删除结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private deleteSnapshot<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    return this.result<Row>([], this.snapshots.delete(`${String(values[0])}:${String(values[1])}`) ? 1 : 0);
  }

  /**
   * 插入、替换或忽略注册条目。
   *
   * @param sql - 用于区分 DO NOTHING/覆盖语义的 SQL
   * @param values - tenant、key 和 JSON value 参数
   * @returns fake 注册表写入结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private insertRegistry<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const key = `${String(values[0])}:${String(values[1])}`;
    if (this.registry.has(key) && sql.includes('DO NOTHING')) return this.result<Row>([], 0);
    this.registry.set(key, { tenantId: String(values[0]), key: String(values[1]), value: JSON.parse(String(values[2])) as Record<string, unknown> });
    return this.result<Row>(sql.includes('RETURNING') ? [{ key: String(values[1]) }] : [], 1);
  }

  /**
   * 查询一个或多个租户注册条目。
   *
   * @param sql - 用于区分单项和列表读取的 SQL
   * @param values - tenantId 及可选 key 参数
   * @returns fake 注册表查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private selectRegistry<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    const candidates = [...this.registry.values()].filter((row) => row.tenantId === String(values[0]));
    const rows = sql.includes('key = $2') ? candidates.filter((row) => row.key === String(values[1])) : candidates.sort((left, right) => left.key.localeCompare(right.key));
    return this.result<Row>(rows.map((row) => ({ key: row.key, value: row.value })), rows.length);
  }

  /**
   * 删除注册条目。
   *
   * @param values - tenantId 和 key 参数
   * @returns fake 删除结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private deleteRegistry<Row extends Record<string, unknown>>(values: readonly unknown[]): { rows: Row[]; rowCount: number } {
    return this.result<Row>([], this.registry.delete(`${String(values[0])}:${String(values[1])}`) ? 1 : 0);
  }

  /**
   * 以泛型形式返回 fake 查询结果，保持与真实客户端一致。
   *
   * @param rows - 待返回的未知行集合
   * @param rowCount - 影响行数
   * @returns 带泛型行类型的查询结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private result<Row extends Record<string, unknown>>(rows: unknown[], rowCount: number): { rows: Row[]; rowCount: number } {
    return { rows: rows as Row[], rowCount };
  }

  /**
   * 用快照内容替换 Map，模拟事务回滚而不替换共享引用。
   *
   * @param target - 需要原地恢复的目标 Map
   * @param source - 事务开始时保存的源 Map
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private replaceMap<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear();
    source.forEach((value, key) => target.set(key, value));
  }
}

/** 模拟数据库驱动故障，验证上层只收到稳定错误。 */
export class FailingPostgresClient implements PostgresQueryClient {
  /**
   * 连接获取本身成功，故障发生在 DDL 查询。
   *
   * @returns 当前故障 fake 作为事务连接
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async connect(): Promise<FailingPostgresClient> {
    return this;
  }

  /**
   * 所有查询均抛出包含敏感驱动文本的错误。
   *
   * @param text - 被拒绝执行的 SQL 文本
   * @param values - 被拒绝传入的 SQL 参数
   * @returns 永不成功的查询 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async query<Row extends Record<string, unknown> = Record<string, unknown>>(_text?: string, _values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }> {
    throw new Error('secret postgres://user:password@host/db connection failure');
  }

  /**
   * 兼容事务连接释放接口。
   *
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public release(): void {}
}
