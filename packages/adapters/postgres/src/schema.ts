/**
 * 初始化带租户复合键的 PostgreSQL 表结构。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { mapPostgresConflict } from './transaction.js';
import type { PostgresQueryClient } from './types.js';

/** 所有 Phase 1 存储边界共用的 PostgreSQL DDL。 */
export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS iar_events (
  sequence BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE (tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS iar_events_tenant_run_sequence
  ON iar_events (tenant_id, run_id, sequence);
CREATE TABLE IF NOT EXISTS iar_snapshots (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  context JSONB NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);
CREATE TABLE IF NOT EXISTS iar_registry (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  PRIMARY KEY (tenant_id, key)
);`;

// 事件、快照和注册表都使用租户复合键，避免单列业务 ID 形成全局碰撞。
// JSONB 保留可重放载荷，sequence 保留事件追加顺序，索引服务租户内 run 查询。
// DDL 不包含默认租户、默认凭据或生产连接信息。
// 所有表均可重复初始化，适配器重启不会删除历史事实。
// 迁移版本化和在线升级不在本任务内伪装成初始化逻辑。

/**
 * 幂等创建 PostgreSQL 存储表和索引。
 *
 * @param client - 生产连接池或进程内 PostgreSQL 语义客户端
 * @returns DDL 完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function initializePostgresSchema(client: PostgresQueryClient): Promise<void> {
  // DDL 只走注入的 Pool-like client，不在适配器内部创建隐式连接。
  // 所有表声明都使用固定名称，避免用户输入进入 DDL。
  // IF NOT EXISTS 使重复启动保持幂等，不删除任何历史记录。
  // 只有 DDL 成功后业务 store 才会继续执行参数化读写。
  try {
    await client.query(POSTGRES_SCHEMA_SQL);
  } catch (error) {
    // 迁移/连接错误不能把底层驱动 message 暴露给 Service API。
    throw mapPostgresConflict(error, 'schema');
  }
}
