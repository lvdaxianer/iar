/**
 * 组合 PostgreSQL 的三类 IAR 存储，并固定其租户范围。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { StorageValidationError, type EventStore, type RegistryStore, type SnapshotStore } from '../../../storage/src/index.js';
import { PostgresEventStore } from './event-store.js';
import { initializePostgresSchema } from './schema.js';
import { PostgresRegistryStore } from './registry-store.js';
import { PostgresSnapshotStore } from './snapshot-store.js';
import { assertIdentifier } from './serialization.js';
import type { PostgresQueryClient, PostgresStorageOptions } from './types.js';

/** 同一连接池只执行一次幂等 schema 初始化。 */
const schemaInitializations = new WeakMap<PostgresQueryClient, Promise<void>>();

/** 面向 Service 的租户绑定存储组合。 */
export type TenantStorageBundle = {
  tenantId: string;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  registryStore: RegistryStore;
};

/** PostgreSQL 三类存储的统一入口。 */
export class PostgresStorageAdapter implements TenantStorageBundle {
  /** 公开租户标识只用于审计/路由，不允许单次调用覆盖。 */
  public readonly tenantId: string;
  /** 当前租户的事件事实源。 */
  public readonly eventStore: EventStore;
  /** 当前租户的快照存储。 */
  public readonly snapshotStore: SnapshotStore;
  /** 当前租户的注册表。 */
  public readonly registryStore: RegistryStore;
  /** DDL 初始化完成后才允许进行业务读写。 */
  private readonly initialization: Promise<void>;

  // 三个 store 共享同一个 client 和初始化 Promise，避免 Service 层出现不同 schema 生命周期。
  // 每个 store 只收到构造时的 tenantId，业务调用没有覆盖租户的参数入口。
  // ready() 单独暴露启动门禁，使部署层可以在接收请求前报告 DDL 失败。
  // 适配器本身不创建连接池，也不读取环境变量，避免绕过 Service 配置边界。

  /**
   * 创建带租户边界的 PostgreSQL 适配器。
   *
   * @param options - 连接池和租户绑定参数
   * @returns 已完成接口组合的适配器实例
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: PostgresStorageOptions) {
    // 运行时调用方可能绕过 TypeScript，先拒绝 null、空对象和伪造 client。
    assertAdapterOptions(options);
    // 构造阶段先拒绝空租户，确保后续 SQL 永远存在有效范围。
    assertTenantId(options.tenantId);
    // schema Promise 只创建一次，三个 store 共享同一启动状态。
    // store 实例只持有接口，不向调用方暴露 client 或 DDL。
    // tenantId 在此处写入后保持 readonly，避免运行中跨租户漂移。
    this.tenantId = options.tenantId;
    // 初始化 Promise 失败会在 ready() 和任一 store 首次操作时保持同一失败结果。
    this.initialization = schemaReady(options.client);
    // 下面的三个实例共享同一个启动门禁，但各自保持独立公共契约。
    this.eventStore = new PostgresEventStore(options.client, this.tenantId, this.initialization);
    this.snapshotStore = new PostgresSnapshotStore(options.client, this.tenantId, this.initialization);
    this.registryStore = new PostgresRegistryStore(options.client, this.tenantId, this.initialization);
  }

  /**
   * 等待一次性 schema 初始化，便于服务启动阶段 fail-fast。
   *
   * @returns schema 初始化完成的 Promise
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async ready(): Promise<void> {
    // 初始化失败原样转换为稳定 StoragePersistenceError 后交给启动层处理。
    await this.initialization;
  }
}

/**
 * 校验租户标识，避免空范围或空白范围被当成合法上下文。
 *
 * @param tenantId - 待绑定的租户标识
 * @returns 无返回值；无效时抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertTenantId(tenantId: string): void {
  assertIdentifier(tenantId, 'tenantId', 128);
}

/**
 * 在运行时验证适配器构造参数，避免 WeakMap/Promise 先抛出原生异常。
 *
 * @param options - 未信任的适配器构造参数
 * @returns 无返回值；无效时抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertAdapterOptions(options: unknown): asserts options is PostgresStorageOptions {
  try {
    if (typeof options !== 'object' || options === null) throw new StorageValidationError('PostgreSQL 存储配置无效');
    const candidate = options as { client?: unknown; tenantId?: unknown };
    if (typeof candidate.tenantId !== 'string') throw new StorageValidationError('tenantId 无效');
    assertPostgresClient(candidate.client);
  } catch (error) {
    // getter 或 Proxy 访问配置失败时也必须归一化为稳定校验错误。
    if (error instanceof StorageValidationError) throw error;
    throw new StorageValidationError('PostgreSQL 存储配置无效');
  }
}

/**
 * 验证注入 client 具备参数化查询和专用连接能力。
 *
 * @param client - 未信任的连接池或客户端
 * @returns 无返回值；无效时抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertPostgresClient(client: unknown): asserts client is PostgresQueryClient {
  // null、数字和字符串没有连接池能力，不能交给 WeakMap 或 schema 初始化。
  if (typeof client !== 'object' || client === null) throw new StorageValidationError('PostgreSQL client 无效');
  const candidate = client as { query?: unknown; connect?: unknown };
  // 缺少 query/connect 时拒绝伪造 client，避免后续产生未处理 rejected Promise。
  if (typeof candidate.query !== 'function' || typeof candidate.connect !== 'function') {
    throw new StorageValidationError('PostgreSQL client 无效');
  }
}

/**
 * 返回连接池级别共享的 schema 初始化 Promise。
 *
 * @param client - 连接池级别的 PostgreSQL client
 * @returns 可共享的初始化 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function schemaReady(client: PostgresQueryClient): Promise<void> {
  const existing = schemaInitializations.get(client);
  // 已有初始化无论成功或失败都先复用，避免同一启动周期重复 DDL。
  if (existing) return existing;
  const initialization = initializePostgresSchema(client).catch((error: unknown) => {
    // 失败后清除缓存，允许部署层在修复临时数据库故障后显式重试。
    schemaInitializations.delete(client);
    throw error;
  });
  schemaInitializations.set(client, initialization);
  return initialization;
}

/** 保持公共导出类型可被 service adapter 复用。 */
export type { PostgresQueryClient };
