# Phase 1 / Task 1.4 Per-task Audit

日期：2026-10-17

## 计划—实现一致性

| 计划要求 | 实现证据 |
| --- | --- |
| EventStore | `packages/storage/src/types.ts` 定义追加、批量追加、按运行查询和按事件 ID 查询；`memory-stores.ts` 与 `sqlite-stores.ts` 提供适配器。 |
| SnapshotStore | 内存和 SQLite 适配器保存、读取、替换和删除最新 BehaviorContext 快照，并隔离嵌套引用。 |
| RegistryStore | 内存和 SQLite 适配器提供 JSON 注册条目的增删改查和稳定排序。 |
| BehaviorContext projection | `packages/runtime/src/context-projector.ts` 按 workflow、decision、action 事件更新 subject、intent、route、workflow 和幂等键。 |
| 关键字段哈希 | Runtime 对 subject、intent、action、route、slots、workflow、pending、confirmation 和 idempotencyKey 做确定性 canonical JSON + SHA-256。 |
| 事件重放 | `replayEvents()` 从固定初始状态按事件顺序投影，重复相同事件序列得到相同状态。 |
| Action 幂等 | `ActionIdempotencyLedger` 首次接受幂等键，重复键返回 `action.duplicate_idempotency_key` 且不增加第二个已启动 Action。 |

## 测试与验证证据

- RED：新增 replay 测试首次运行时，`packages/storage/src/index.js` 和 `packages/runtime/src/index.js` 不存在，TypeScript 编译按预期失败。
- GREEN：`npm test -- --run tests/replay/storage-runtime.test.ts`，15/15 通过。
- Focused：`npm test -- --run tests/replay tests/contract`，37/37 通过。
- Broader：`npm run lint`、`npm run build`、`npm test`，38/38 通过。
- SQLite：使用 Node.js 内置 `node:sqlite` 的内存数据库和文件数据库 reopen 验证三类适配器及幂等恢复。
- Lint：`npm run lint` 通过。
- Adversarial：覆盖批量克隆失败原子性、非法 JSON/Envelope、旧快照回退、跨 run replay、完整关键字段投影、投影失败回滚和 ledger 重建后的持久化幂等。

## 适用规则检查

- `development-workflow`：遵循独立 worktree、TDD RED→GREEN、focused/broader verification、独立 code review 和 per-task audit 顺序。
- `backend-reliability-guidelines`：批量事件写入保持原子性；事件 ID 冲突显式报错；快照和注册表返回深拷贝；SQLite 其他错误不被伪装成冲突。
- `code-review-spec`：公开 Store 接口、确定性哈希、错误码和 replay/idempotency 测试均有证据。

## 独立审查处置

- 最终独立 code review：APPROVED；确认投影失败回滚、内存/SQLite 原子性、快照 revision、持久化幂等和 replay 边界无阻塞问题。

## 未解决风险

- SQLite 适配器依赖 Node.js 24 的内置 `node:sqlite`，未引入第三方 SQLite 驱动；当前项目 engines 已声明 Node.js `>=24`。
- BehaviorContext 的 compaction result/schema guard 将在 Task 1.6 扩展；本任务只保留关键字段完整性替换门禁。
