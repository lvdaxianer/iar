/**
 * 定义 PostgreSQL 适配器使用的最小参数化查询边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */

/**
 * 兼容 pg Client/Pool.query 返回形状的查询结果。
 *
 * @template Row - 查询结果行类型
 * @property rows - 查询返回的行集合
 * @property rowCount - 受影响行数，驱动可能返回 null
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  // pg 的 rowCount 在部分命令上可能为 null，调用方必须显式处理。
  rows: Row[];
  rowCount: number | null;
};

/**
 * PostgreSQL 事务连接的最小依赖。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export interface PostgresQueryConnection {
  // 事务中所有 query 必须复用同一个后端连接。
  /**
   * 在当前连接上执行参数化 SQL。
   *
   * @param text - 使用 `$n` 占位符的 SQL 文本
   * @param values - 与占位符一一对应的参数
   * @returns 查询结果行和影响行数
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<PostgresQueryResult<Row>>;
  /**
   * 将连接归还连接池；单连接客户端可以实现为空操作。
   *
   * @returns 释放完成的 Promise 或同步完成标志
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  release(): void | Promise<void>;
}

/**
 * PostgreSQL 连接池或客户端的最小依赖。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export interface PostgresQueryClient {
  // 这是 Pool-like 边界，不宣称兼容无需返回连接的 pg.Client.connect()。
  /**
   * 执行带 `$n` 占位符的参数化 SQL。
   *
   * @param text - 使用 `$n` 占位符的 SQL 文本
   * @param values - 与占位符一一对应的参数
   * @returns 查询结果行和影响行数
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<PostgresQueryResult<Row>>;
  /**
   * 获取一个连接，保证事务内所有语句使用同一后端连接。
   *
   * @returns 可执行事务 SQL 的专用连接
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  connect(): Promise<PostgresQueryConnection>;
}

/** PostgreSQL 适配器构造参数。 */
export type PostgresStorageOptions = {
  /** 由 Service 边界绑定、不可由单次查询覆盖的租户。 */
  tenantId: string;
  /** 生产环境通常传入 pg.Pool，测试可以传入确定性 fake。 */
  client: PostgresQueryClient;
};
