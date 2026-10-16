# Phase 1 / Task 1.3 Per-task Audit

日期：2026-10-17

## 审计结论

PASS。实现与 OpenSpec Task 1.3 的范围和验收条件一致，可以进入任务勾选、提交和合并门禁。

## 计划—实现一致性

| 计划要求 | 实现证据 |
| --- | --- |
| Manifest 校验 | `packages/contracts/src/validation.ts` 统一校验 API/schema 版本、嵌入 JSON Schema、能力子集和高风险确认关系；`packages/plugin-host/src/plugin-host.ts` 安装前调用该校验。 |
| Function 归属 | `PluginHost` 校验已注册 Function ID；`candidates()` 只返回同一 Function 的业务插件；`resolveCandidate()` 对归属不匹配返回 `plugin.ownership_mismatch` 并写拒绝事件。 |
| 依赖排序 | `packages/plugin-host/src/dependency-order.ts` 使用固定 code-point 顺序进行确定性拓扑排序，并拒绝缺失依赖、依赖环和重复插件 ID。 |
| 注册表原子性 | 校验、排序和安装集合检查全部成功后才写入 `records`；失败路径只追加拒绝事件，不改变当前注册表。返回记录和安装输入均通过深拷贝隔离。 |
| 生命周期 | 支持 installed、enabled、draining、disabled、unloaded；discovered/validated 作为安装事务阶段事件；依赖启用、反向依赖停用/卸载均有状态门禁。 |
| 事件保留 | 内部事件日志使用私有递增 ID；`events` 和 `history()` 只返回深拷贝快照；卸载删除当前能力但不删除事件历史。 |
| SDK 边界 | `@iar/plugin-sdk` 提供 Handler/Registration 类型；Host 可保存带 Handler 的注册对象，并声明 `@iar/contracts` 依赖。 |

## 测试与验证证据

- RED：首次运行插件生命周期测试时，`plugin-host` 入口缺失导致编译失败。
- GREEN：`npm test -- --run tests/contract`，23/23 通过。
- Focused：`npm test -- --run tests/contract tests/replay`，22/22 通过（当前 replay 目录为空）。
- Broader：`npm run lint`、`npm run build`、`npm test`，23/23 通过。
- Package boundary：`@iar/contracts`、`@iar/plugin-host` 公开入口导入通过。
- OpenSpec：`npx openspec validate iar-five-phase-roadmap --strict` 通过。
- Hygiene：`git diff --check` 通过，构建产物未进入版本控制。

## 独立审查处置

- 第一轮审查的注册表深层引用、依赖状态失效、事件可变、Function ownership 审计、SDK 依赖和 Handler 接入问题已修复。
- 第二轮审查指出的重复注册错误码、locale-sensitive 排序、Manifest 能力去重/高风险确认校验和测试缺口已修复。
- 最终审查前修复了未知 Function 拒绝事件的真实 pluginId 归因、批量安装上限、Set 线性重复检测，并补充超限/混合批量原子性和 disabled 事件 from/to 测试；安装测试按边界职责拆分，最大测试文件 317 行。
- 审查建议中的长期 EventStore retention、生命周期 Hook 执行器和外部隔离执行属于后续 Phase 1.4/Phase 4 范围，不在本任务的允许文件和验收条件内。

## 适用规则检查

- `development-workflow`：遵循专用 worktree、TDD RED→GREEN、focused/broader verification、独立 code review、per-task audit 顺序。
- `code-review-spec`：公共类型、稳定错误码、边界条件、中文注释和测试证据已覆盖。
- `backend-reliability-guidelines`：安装事务保持原子性；失败返回结构化错误；依赖状态和 Function 归属在运行时再次校验；审计事件不可变快照化。

