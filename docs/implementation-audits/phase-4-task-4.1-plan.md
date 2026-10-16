# Phase 4 Task 4.1 实现计划

## Task boundary and dispatch

- 模块：`packages/adapters/postgres/**`、`packages/adapters/service/**`、`tests/integration/service/**`。
- 责任：提供 PostgreSQL 参数化 SQL 存储适配器、租户绑定边界和面向 Service 的统一存储门面。
- 允许修改：上述模块、对应 package 入口、Phase 4.1 focused tests、该计划/审计文件和 OpenSpec checklist；不改变 Phase 1～3 的公共运行时语义。
- 排除范围：真实网络服务端、Sidecar transport、CLI、Worker/container executor、OpenTelemetry/Pino、Temporal 和远程插件目录。
- 依赖：`@iar/storage` 的 `EventStore`、`SnapshotStore`、`RegistryStore` 契约；SQLite 适配器作为同一 contract test 的基线。
- 分派：当前任务由主代理直接执行；跨模块写入范围较小且共享存储语义需要串行设计，未拆分独立子代理。
- RED：先添加 SQLite/PostgreSQL 双适配器 contract test、PostgreSQL 租户隔离 test 和 Service tenant binding test，确认目标适配器/入口不存在。
- 聚焦验证：`npm test -- --run tests/integration/service`。
- 广度验证：`npm run lint && npm run build && npm test`。

## Design decisions

1. PostgreSQL 适配器采用注入式 `PostgresQueryClient`，其形状兼容 `pg.Pool`/`pg.Client` 的参数化 `query` 与专用 `connect`；生产连接池由 Service/部署层注入，测试同时使用 `pg-mem` 进程内 PostgreSQL 语义和确定性 fake client。
2. 每个存储实例在构造时绑定非空 `tenantId`；事件、快照、注册表的 schema 和所有 SQL 读写都包含 `tenant_id`，调用方不能通过公共 `EventStore` 参数改变租户范围。Service 只有在显式 `TenantAuthorizer` 通过 actor/tenant 授权后才创建绑定存储。
3. PostgreSQL 事件使用 `(tenant_id, event_id)` 唯一约束和顺序列，快照使用 `(tenant_id, run_id)` 主键，注册表使用 `(tenant_id, key)` 主键；批量事件和快照 revision 更新使用事务，冲突映射为现有 `StorageConflictError`。
4. Service adapter 只负责按 tenant 创建/缓存绑定的三类 store，不向上层暴露 SQL client，也不允许跨租户复用已有绑定；它保持与 Embedded storage 相同的异步接口和安全错误语义。
5. SQLite 和 `pg-mem` PostgreSQL contract test 运行同一组用例；fake client 额外断言所有查询均携带当前 tenant 参数，并覆盖数据库故障、循环 JSON 和 malformed snapshot 的稳定错误边界。

## Reliability and security evidence

- 外部输入：tenantId、事件、快照和 registry value 均做非空/契约/JSON 边界校验，失败不写库。
- 授权边界：tenantId 是 Service 创建绑定的上下文，跨租户读取只返回 `undefined`，跨租户写入不会改变另一租户数据。
- 幂等/并发：数据库唯一约束负责事件和 registry 首次写入；快照 revision 在事务内比较，避免旧快照覆盖新状态。
- 错误：SQL 冲突转换为稳定 `StorageConflictError`，不向调用方暴露 SQL、连接串或数据库原始错误详情。
- 日志：本任务不新增生产日志；PostgreSQL 查询不记录 payload、registry value、tenant secret 或连接信息。
