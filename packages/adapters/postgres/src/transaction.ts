/**
 * 为 PostgreSQL 写操作提供统一事务边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { StorageConflictError, StoragePersistenceError, StorageValidationError } from '../../../storage/src/index.js';
import type { PostgresQueryClient, PostgresQueryConnection, PostgresQueryResult } from './types.js';

/**
 * 在 BEGIN/COMMIT 之间执行写操作，失败时回滚并保留稳定错误。
 *
 * @param client - 提供专用事务连接的 PostgreSQL 连接池
 * @param operation - 只允许使用事务连接的写操作
 * @returns 写操作返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function withTransaction<T>(client: PostgresQueryClient, operation: (connection: PostgresQueryConnection) => Promise<T>): Promise<T> {
  let connection: PostgresQueryConnection | undefined;
  let operationFailed = false;
  try {
    // 事务必须从池取得专用连接，不能让 Pool.query 在语句间切换后端。
    connection = await client.connect();
    await connection.query('BEGIN');
    const result = await operation(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    // 任一步骤失败都先尝试回滚，再把驱动错误转换成稳定错误。
    operationFailed = true;
    if (connection) await rollbackQuietly(connection);
    throw mapPostgresConflict(error, '事务');
  } finally {
    // 无论成功失败都归还专用连接，避免连接池泄漏。
    if (connection) await releaseQuietly(connection, operationFailed);
  }
}

/**
 * 回滚失败不能覆盖原始业务错误，也不能向调用方暴露连接细节。
 *
 * @param connection - 当前事务的专用连接
 * @returns 回滚尝试完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function rollbackQuietly(connection: PostgresQueryConnection): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // 原始写入错误包含更准确的稳定语义，回滚错误不改变它。
  }
}

/**
 * 释放连接失败时只在主操作成功的路径上抛出稳定错误。
 *
 * @param connection - 当前事务的专用连接
 * @param operationFailed - 主操作是否已经失败
 * @returns 资源释放完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function releaseQuietly(connection: PostgresQueryConnection, operationFailed: boolean): Promise<void> {
  try {
    await connection.release();
  } catch (error) {
    if (!operationFailed) throw mapPostgresConflict(error, '连接释放');
  }
}

/**
 * 将 PostgreSQL 唯一约束或驱动异常转换成存储层稳定错误。
 *
 * @param error - PostgreSQL 驱动抛出的未知错误
 * @param key - 发生冲突的安全业务键
 * @returns 不泄露 SQL/连接信息的稳定错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function mapPostgresConflict(error: unknown, key: string): Error {
  // 已经稳定化的业务错误保持原类型，避免重复包装丢失语义。
  if (error instanceof StorageConflictError || error instanceof StorageValidationError || error instanceof StoragePersistenceError) return error;
  // SQLSTATE 23505 表示唯一约束冲突，只返回安全业务键。
  if (isUniqueViolation(error)) return new StorageConflictError(`存储键已存在: ${key}`);
  // 其他驱动错误统一隐藏 SQL、连接串和底层 message。
  return new StoragePersistenceError('PostgreSQL 存储操作失败');
}

/**
 * 统一包装读写错误，避免数据库驱动文本泄露给上层。
 *
 * @param client - 当前连接池或事务连接
 * @param text - 参数化 SQL 文本
 * @param values - SQL 占位符值
 * @returns 驱动查询结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function querySafely<Row extends Record<string, unknown> = Record<string, unknown>>(
  client: PostgresQueryClient | PostgresQueryConnection,
  text: string,
  values?: readonly unknown[]
): Promise<PostgresQueryResult<Row>> {
  try {
    return await client.query<Row>(text, values);
  } catch (error) {
    throw mapPostgresConflict(error, '查询');
  }
}

/**
 * 只读取 PostgreSQL 稳定 SQLSTATE，不拼接原始数据库错误。
 *
 * @param error - 待识别的未知驱动错误
 * @returns 是否为唯一约束冲突
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isUniqueViolation(error: unknown): boolean {
  // 只有明确的 PostgreSQL SQLSTATE 才能判定为冲突，其余一律按持久化失败处理。
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
