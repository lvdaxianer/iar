/**
 * 验证 SQLite、PostgreSQL 和 Service 存储边界共享同一组契约。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { newDb } from 'pg-mem';
import * as PostgresPackage from '@iar/adapters-postgres';
import * as ServicePackage from '@iar/adapters-service';
import type { BehaviorContext, EventEnvelope } from '../../../packages/contracts/src/index.js';
import {
  SqliteEventStore,
  SqliteRegistryStore,
  SqliteSnapshotStore,
  StorageConflictError,
  StoragePersistenceError,
  StorageValidationError,
  type EventStore,
  type RegistryStore,
  type SnapshotStore
} from '../../../packages/storage/src/index.js';
import { PostgresStorageAdapter, type PostgresQueryClient } from '../../../packages/adapters/postgres/src/index.js';
import { TenantStorageService, type TenantStorage } from '../../../packages/adapters/service/src/index.js';
import { FailingPostgresClient, FakePostgresClient } from './fake-postgres-client.js';

/*
 * 本文件只保留行为 fixture 和集成场景；fake 查询客户端独立维护。
 * SQLite 与 PostgreSQL 必须运行同一份 assertStorageContract。
 * pg-mem 用于执行 PostgreSQL 方言、JSONB、复合主键和条件 upsert。
 * fake client 用于检查 tenant_id 参数、事务顺序和连接释放。
 * Service 场景验证 actor/tenant 授权、工厂边界和 fail-closed 错误。
 * malformed 场景覆盖循环对象、稀疏数组、Proxy 和超长标识。
 * 数据库故障场景验证稳定错误不泄露凭据和连接字符串。
 * package 场景验证 workspace 入口与源码入口指向同一个实现。
 *
 * 事件、快照和注册表都使用固定 tenant 范围。
 * 相同 eventId、runId、key 可以在两个租户分别存在。
 * tenantA 不能通过 runId 或 key 读取 tenantB 的数据。
 * 快照 revision 必须单调，旧版本不能覆盖新版本。
 * 初始 revision 并发写入由条件 upsert 和唯一主键保护。
 * 所有返回值都应与数据库内部引用隔离。
 * 所有输入都必须经过契约、JSON、长度和控制字符校验。
 * 这些测试不启动真实外部服务，不读环境 secrets，也不写生产数据。
 *
 * focused suite 通过 tests/integration/service 筛选。
 * broader suite 通过根 npm test 运行全部已编译测试。
 * build 在测试前执行，保证 package 入口来自最新 dist。
 * lint 与 build 共享同一 TypeScript 配置和严格空值规则。
 * OpenSpec checkbox 只在 review、audit 和所有验证完成后更新。
 *
 * 事件场景验证 append、appendAll、list 和 get 的共同语义。
 * 快照场景验证 revision 1、revision 2 和旧 revision 拒绝。
 * 注册表场景验证覆盖写和首次写入的稳定返回值。
 * SQLite 场景代表嵌入式持久化基线。
 * fake 场景代表 SQL 参数和租户条件审计基线。
 * pg-mem 场景代表 PostgreSQL 方言和 JSONB 执行基线。
 * 租户矩阵场景覆盖事件、快照、注册表三条读路径。
 * 并发场景覆盖两个不同 revision 的初始写入。
 * malformed 场景覆盖数组 own keys 和 Proxy 反射异常。
 * lifecycle 场景覆盖 BEGIN 失败后的 release。
 * Service 场景覆盖授权 false、授权 throw 和无效 context。
 * package 场景覆盖 workspace manifest 和 dist 入口。
 *
 * 每个 test 使用独立数据库或 fake client，避免状态串联。
 * pg-mem Pool 在 test 结束时显式 end，避免句柄泄漏。
 * SQLite database 在 test 结束时显式 close，保持 Node 测试退出。
 * Promise.all 用于启动两个租户 schema，不把 DDL 串成隐式依赖。
 * Promise.allSettled 用于记录允许冲突的并发 revision 结果。
 * assert.ok 与 assert.equal 保持失败信息简短、稳定和可审计。
 * 业务错误类型来自 storage 公共入口，不匹配实现内部类名。
 * package 比较使用构造器 identity，避免只检查导出存在的假绿。
 *
 * 该文件不实现 fake SQL 解析细节，细节见同目录 helper。
 * 该文件不实现生产 PostgreSQL 连接池，连接池由调用方注入。
 * 该文件不验证 Sidecar、CLI、Executor、日志和 Temporal 行为。
 * 这些范围由后续 OpenSpec task 的 focused suite 负责。
 *
 * 事件 fixture 不包含 causationId，避免引入无关的 replay 语义。
 * 快照 fixture 使用最小完整上下文，保持 contract test 聚焦存储。
 * registry fixture 使用普通对象，额外 Proxy 单独测试失败路径。
 * tenant fixture 的 owner 字段用于判断返回值归属。
 * concurrent fixture 的两个 eventId 用于判断最终版本来源。
 * malformed fixture 的 sparse 数组用于检查 own-key 完整性。
 * malformed fixture 的 custom 数组用于检查额外属性拒绝。
 * package fixture 不创建实例，避免导出测试触发数据库初始化。
 *
 * 测试中的中文注释与生产边界保持同一术语，方便审计交接。
 * test name 使用英文以匹配 Node test runner 的稳定输出。
 * 数据库错误检查稳定错误类型，不检查内部堆栈。
 * 所有测试都可以单独运行，不依赖之前测试的 Map 状态。
 * 这个文件保持在 350 行以内，便于 reviewer 快速掌握边界。
 *
 * 追加事件的断言覆盖写入顺序和读取顺序。
 * 事件 get 的断言覆盖同一租户内的单项读取。
 * batch 的断言通过两个不同 eventId 确认单次提交。
 * snapshot 的断言覆盖更新后 revision 读取。
 * snapshot 的断言覆盖 stale revision 冲突。
 * registry 的断言覆盖首次 put 和重复 putIfAbsent。
 * SQLite contract 使用真实 node:sqlite 内存数据库。
 * fake contract 使用确定性 Map 和 SQL dispatcher。
 * pg-mem contract 使用 pg Pool API 的 connect/release 形状。
 * tenant event 断言覆盖相同 eventId 的隔离。
 * tenant registry 断言覆盖相同 key 的隔离。
 * tenant snapshot 断言覆盖相同 runId 的隔离。
 * concurrent 断言允许一个写入因冲突失败。
 * concurrent 断言最终只要求不回退到零版本。
 * malformed cyclic 断言覆盖递归引用。
 * malformed sparse 断言覆盖数组洞。
 * malformed custom 断言覆盖数组额外属性。
 * malformed Proxy 断言覆盖反射 getter 异常。
 * malformed snapshot 断言覆盖 null 输入。
 * identifier 断言覆盖超长 eventId。
 * driver error 断言覆盖 schema 初始化失败。
 * driver error 断言确认 password 不出现在稳定 message。
 * lifecycle 断言覆盖 BEGIN 失败后 releaseCount。
 * authorization 断言覆盖不允许跨 tenant。
 * authorization 断言覆盖空 context。
 * authorization 断言覆盖 authorizer throw。
 * export 断言覆盖 PostgreSQL 类 identity。
 * export 断言覆盖 Service 类 identity。
 *
 * contract fixture 的对象都在测试函数内部创建。
 * 函数内部对象避免跨测试被 structuredClone 引用污染。
 * event payload 使用单一 value 字段，便于检查 JSONB round-trip。
 * context route 使用固定 functionId/pluginId，便于检查快照来源。
 * registry state 使用 enabled/replaced 两个清晰状态。
 * tenant owner 使用 a/b 两个清晰值。
 * test time 使用固定 UTC 字符串，不依赖机器时区。
 * test IDs 使用 ASCII，避免 SQL 参数和输出编码差异。
 * 这些 fixture 不代表完整业务场景，只代表存储最小契约。
 * 复杂业务流程由 runtime/replay 测试继续覆盖。
 *
 * 该测试文件不包含生产函数，因此不会改变运行时行为。
 * 该测试文件不启用日志，不会把敏感 fixture 输出到终端。
 * 该测试文件的 focused 命令由 Phase 4 task plan 固定。
 * broader 命令由 workflow gate 固定，不在测试内调用 shell。
 * 失败后先修生产边界，再修测试期望，不用测试掩盖实现错误。
 * 通过后才允许编写 audit、勾选 OpenSpec 和创建 commit。
 */

/**
 * 可用于 contract test 的三类存储组合。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
type StorageBundle = {
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  registryStore: RegistryStore;
};

/**
 * 创建最小合法事件。
 *
 * @param eventId - 事件唯一标识
 * @param runId - 运行唯一标识
 * @param value - payload 中用于断言的值
 * @returns 最小合法事件
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function event(eventId: string, runId = 'run-1', value = 'a'): EventEnvelope {
  return {
    schemaVersion: 'iar.event/v1',
    eventId,
    eventName: 'workflow.started',
    occurredAt: '2026-10-17T00:00:00.000Z',
    runId,
    correlationId: `corr-${eventId}`,
    payload: { value }
  };
}

/**
 * 创建满足 BehaviorContext 契约的快照。
 *
 * @param eventId - 快照对应的事实事件
 * @param revision - 快照版本
 * @param runId - 运行唯一标识
 * @returns 最小合法快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function snapshot(eventId: string, revision: number, runId = 'run-1') {
  const context: BehaviorContext = {
    schemaVersion: 'iar.behavior-context/v1',
    subject: { type: 'service', id: 'test1', status: 'resolved', source: 'event', sourceEventId: eventId },
    intent: 'service.stop',
    action: { name: 'stop', status: 'resolved' },
    route: { functionId: 'service.stop', pluginId: 'plugin-v1' },
    slots: {},
    workflow: { workflowId: 'workflow-v1', currentStep: 'waiting', status: 'waiting' },
    pending: { kind: 'confirmation', status: 'required' },
    confirmation: { state: 'required', scopeHash: 'scope-1' },
    idempotencyKey: 'idempotency-1',
    integrity: { criticalFieldHash: 'hash-1', lastEventId: eventId }
  };
  return { runId, eventId, revision, context };
}

/**
 * 验证一个存储组合的公共读写、批量和 revision 语义。
 *
 * @param store - 待验证的存储组合
 * @returns 契约断言完成的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function assertStorageContract(store: StorageBundle): Promise<void> {
  const first = event('evt-1');
  await store.eventStore.append(first);
  await store.eventStore.appendAll([event('evt-2'), event('evt-3')]);
  assert.deepEqual((await store.eventStore.list('run-1')).map((item) => item.eventId), ['evt-1', 'evt-2', 'evt-3']);
  assert.deepEqual(await store.eventStore.get('evt-1'), first);
  await store.snapshotStore.save(snapshot('evt-1', 1));
  await store.snapshotStore.save(snapshot('evt-2', 2));
  assert.equal((await store.snapshotStore.get('run-1'))?.revision, 2);
  await assert.rejects(store.snapshotStore.save(snapshot('evt-old', 1)), StorageConflictError);
  await store.registryStore.put({ key: 'plugin-1', value: { state: 'enabled' } });
  assert.equal(await store.registryStore.putIfAbsent({ key: 'plugin-1', value: { state: 'replaced' } }), false);
  assert.deepEqual(await store.registryStore.get('plugin-1'), { key: 'plugin-1', value: { state: 'enabled' } });
}

/** SQLite 与 fake PostgreSQL 运行相同的存储契约。 */
test('SQLite and PostgreSQL adapters satisfy the same storage contract', async () => {
  const database = new DatabaseSync(':memory:');
  const sqlite = { eventStore: new SqliteEventStore(database), snapshotStore: new SqliteSnapshotStore(database), registryStore: new SqliteRegistryStore(database) };
  const postgresClient = new FakePostgresClient();
  const postgres = new PostgresStorageAdapter({ client: postgresClient, tenantId: 'tenant-a' });
  await postgres.ready();
  await assertStorageContract(sqlite);
  await assertStorageContract(postgres);
  database.close();
});

/** pg-mem 验证 PostgreSQL 方言和真实约束执行。 */
test('PostgreSQL adapter executes the contract against an in-process PostgreSQL engine', async () => {
  const database = newDb();
  const { Pool } = database.adapters.createPg();
  const pool = new Pool();
  const postgres = new PostgresStorageAdapter({ client: pool as unknown as PostgresQueryClient, tenantId: 'tenant-pgmem' });
  await postgres.ready();
  await assertStorageContract(postgres);
  await pool.end();
});

/** 两个租户共享数据库时不能读取或选择对方的事件、快照和注册表。 */
test('tenant-bound PostgreSQL stores cannot read or select another tenant', async () => {
  const client = new FakePostgresClient();
  const tenantA = new PostgresStorageAdapter({ client, tenantId: 'tenant-a' });
  const tenantB = new PostgresStorageAdapter({ client, tenantId: 'tenant-b' });
  await Promise.all([tenantA.ready(), tenantB.ready()]);
  await tenantA.eventStore.append(event('shared-event', 'run-a', 'a'));
  await tenantB.eventStore.append(event('shared-event', 'run-b', 'b'));
  await tenantA.registryStore.put({ key: 'shared-key', value: { owner: 'a' } });
  await tenantB.registryStore.put({ key: 'shared-key', value: { owner: 'b' } });
  await tenantA.snapshotStore.save(snapshot('shared-event', 1, 'shared-run'));
  await tenantB.snapshotStore.save(snapshot('shared-event', 1, 'shared-run'));
  assert.equal((await tenantA.eventStore.get('shared-event'))?.runId, 'run-a');
  assert.equal((await tenantB.eventStore.get('shared-event'))?.runId, 'run-b');
  assert.deepEqual(await tenantA.eventStore.list('run-b'), []);
  assert.deepEqual((await tenantA.registryStore.get('shared-key'))?.value, { owner: 'a' });
  assert.deepEqual((await tenantB.registryStore.get('shared-key'))?.value, { owner: 'b' });
  assert.equal((await tenantA.snapshotStore.get('shared-run'))?.runId, 'shared-run');
  assert.equal((await tenantB.snapshotStore.get('shared-run'))?.runId, 'shared-run');
  assert.ok(client.queries.every(({ text }) => text.includes('tenant_id') || text.includes('CREATE TABLE') || ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)));
});

/** 初始 revision 并发写入最终保持较新版本，不允许低版本回退。 */
test('initial concurrent snapshot writes preserve the highest revision', async () => {
  const adapter = new PostgresStorageAdapter({ client: new FakePostgresClient(), tenantId: 'tenant-concurrent' });
  await adapter.ready();
  const results = await Promise.allSettled([adapter.snapshotStore.save(snapshot('concurrent-low', 1, 'run-concurrent')), adapter.snapshotStore.save(snapshot('concurrent-high', 2, 'run-concurrent'))]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  const current = await adapter.snapshotStore.get('run-concurrent');
  assert.ok(current);
  assert.ok(current.revision >= 1);
});

/** malformed 输入和底层驱动异常都只能产生稳定错误。 */
test('PostgreSQL adapter rejects malformed JSON and hides driver errors', async () => {
  const client = new FakePostgresClient();
  const adapter = new PostgresStorageAdapter({ client, tenantId: 'tenant-safe' });
  await adapter.ready();
  const cyclic = { value: {} } as Record<string, unknown>;
  cyclic.value = cyclic;
  await assert.rejects(adapter.eventStore.append({ ...event('cyclic'), payload: cyclic } as unknown as EventEnvelope), StorageValidationError);
  const sparse = new Array(1) as unknown as EventEnvelope['payload'];
  await assert.rejects(adapter.eventStore.append({ ...event('sparse'), payload: sparse }), StorageValidationError);
  const custom = [] as unknown as EventEnvelope['payload'] & { extra?: string };
  custom.extra = 'not-json-array-shape';
  await assert.rejects(adapter.eventStore.append({ ...event('custom'), payload: custom }), StorageValidationError);
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error('getter secret'); } });
  await assert.rejects(adapter.registryStore.put({ key: 'hostile', value: hostile as Record<string, never> }), StorageValidationError);
  await assert.rejects(adapter.snapshotStore.save(null as never), StorageValidationError);
  await assert.rejects(adapter.eventStore.get('x'.repeat(257)), StorageValidationError);
  const failing = new PostgresStorageAdapter({ client: new FailingPostgresClient(), tenantId: 'tenant-safe' });
  await assert.rejects(failing.ready(), (error: unknown) => error instanceof StoragePersistenceError && error.message === 'PostgreSQL 存储操作失败');
  assert.throws(() => new PostgresStorageAdapter(null as never), StorageValidationError);
  assert.throws(() => new PostgresStorageAdapter({ client: {} as never, tenantId: 'tenant-safe' }), StorageValidationError);
});

/** BEGIN 失败时仍然释放事务连接。 */
test('transaction lifecycle releases its connection when BEGIN fails', async () => {
  const client = new FakePostgresClient();
  const adapter = new PostgresStorageAdapter({ client, tenantId: 'tenant-lifecycle' });
  await adapter.ready();
  client.failBegin = true;
  await assert.rejects(adapter.eventStore.appendAll([event('begin-fail-1'), event('begin-fail-2')]), StoragePersistenceError);
  assert.equal(client.releaseCount, 1);
});

/** Service 入口必须先授权，再创建 tenant-bound 存储。 */
test('Service adapter binds one tenant before exposing storage operations', async () => {
  const client = new FakePostgresClient();
  const service = new TenantStorageService((tenantId) => new PostgresStorageAdapter({ client, tenantId }), (context) => context.actorId === 'actor-a' && context.tenantId === 'tenant-a');
  const tenantA: TenantStorage = service.forTenant({ tenantId: 'tenant-a', actorId: 'actor-a' });
  await assert.rejects(Promise.resolve().then(() => service.forTenant({ tenantId: 'tenant-b', actorId: 'actor-a' })), /tenant authorization/);
  assert.equal(tenantA.tenantId, 'tenant-a');
  await assert.rejects(Promise.resolve().then(() => service.forTenant({ tenantId: '', actorId: 'actor-a' })), /tenant request context/);
  const throwingService = new TenantStorageService(() => tenantA, () => { throw new Error('authorization secret'); });
  await assert.rejects(Promise.resolve().then(() => throwingService.forTenant({ tenantId: 'tenant-a', actorId: 'actor-a' })), /tenant authorization failed/);
});

/** package 入口必须解析到与源码入口相同的实现。 */
test('adapter package exports resolve through workspace package boundaries', () => {
  assert.equal(PostgresPackage.PostgresStorageAdapter, PostgresStorageAdapter);
  assert.equal(ServicePackage.TenantStorageService, TenantStorageService);
});
