/**
 * 提供带租户复合键的 PostgreSQL RegistryStore。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { StorageConflictError, type RegistryEntry, type RegistryStore } from '@iar/storage';
import { assertIdentifier, cloneJsonValue } from './serialization.js';
import { querySafely } from './transaction.js';
import type { PostgresQueryClient } from './types.js';

/** 注册表查询行。 */
type RegistryRow = { key: string; value: RegistryEntry['value'] };

/** 租户绑定的 PostgreSQL 注册表。 */
export class PostgresRegistryStore implements RegistryStore {
  /**
   * 创建只使用固定 tenantId 的注册表存储。
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
   * 保存或替换当前租户的注册条目。
   *
   * @param entry - 可持久化 JSON 注册条目
   * @returns 写入完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async put(entry: RegistryEntry): Promise<void> {
    assertIdentifier(entry.key, 'key');
    const clonedValue = cloneJsonValue(entry.value);
    await this.readyPromise;
    await querySafely(this.client,
      'INSERT INTO iar_registry (tenant_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value',
      [this.tenantId, entry.key, JSON.stringify(clonedValue)]
    );
  }

  /**
   * 只在当前租户 key 不存在时原子写入。
   *
   * @param entry - 首次写入的注册条目
   * @returns 是否成功占用该 key
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async putIfAbsent(entry: RegistryEntry): Promise<boolean> {
    assertIdentifier(entry.key, 'key');
    const clonedValue = cloneJsonValue(entry.value);
    await this.readyPromise;
    const existing = await querySafely(this.client, 'SELECT key FROM iar_registry WHERE tenant_id = $1 AND key = $2', [this.tenantId, entry.key]);
    if (existing.rows.length > 0) return false;
    try {
      const result = await querySafely(this.client, 'INSERT INTO iar_registry (tenant_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key', [this.tenantId, entry.key, JSON.stringify(clonedValue)]);
      return result.rows.length > 0;
    } catch (error) {
      if (error instanceof StorageConflictError) return false;
      throw error;
    }
  }

  /**
   * 查询当前租户的注册条目。
   *
   * @param key - 注册条目键
   * @returns 注册条目副本或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async get(key: string): Promise<RegistryEntry | undefined> {
    assertIdentifier(key, 'key');
    await this.readyPromise;
    const result = await querySafely<RegistryRow>(this.client, 'SELECT key, value FROM iar_registry WHERE tenant_id = $1 AND key = $2', [this.tenantId, key]);
    const row = result.rows[0];
    return row ? { key: row.key, value: cloneJsonValue(row.value) } : undefined;
  }

  /**
   * 按 key 返回当前租户的注册条目。
   *
   * @returns 稳定排序的注册条目副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async list(): Promise<RegistryEntry[]> {
    await this.readyPromise;
    const result = await querySafely<RegistryRow>(this.client, 'SELECT key, value FROM iar_registry WHERE tenant_id = $1 ORDER BY key', [this.tenantId]);
    return result.rows.map((row) => ({ key: row.key, value: cloneJsonValue(row.value) }));
  }

  /**
   * 删除当前租户的注册条目。
   *
   * @param key - 注册条目键
   * @returns 删除完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async delete(key: string): Promise<void> {
    assertIdentifier(key, 'key');
    await this.readyPromise;
    await querySafely(this.client, 'DELETE FROM iar_registry WHERE tenant_id = $1 AND key = $2', [this.tenantId, key]);
  }
}
