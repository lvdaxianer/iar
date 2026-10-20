# Package Boundary Consolidation Baseline

日期：2026-10-20

## Workspace inventory

当前 workspace 包共 24 个：

- 核心包 18 个：`abi`、`built-in-plugins`、`cli`、`contracts`、`control-plane`、`decision`、`observability`、`persistence-runtime`、`persistence-spi`、`persistence-sqlite`、`plugin-distribution`、`plugin-host`、`plugin-sdk`、`rule-engine`、`runtime`、`storage`、`subscriptions`、`workflow`。
- 适配器包 6 个：`adapters/executors`、`adapters/fastify`、`adapters/postgres`、`adapters/service`、`adapters/sidecar`、`adapters/temporal`。

所有内部 `@iar/*` 包当前均为私有包。workspace 只匹配 `packages/*` 和 `packages/adapters/*`；`examples` 不作为 workspace package。

## Build references

`tsconfig.build.json` 当前为 24 个 package-local `tsconfig.build.json` 提供 project references。根 `tsconfig.json` 通过 `paths` 将 `@iar/*` 映射到 `packages/*/src/index.ts`，并将 `packages`、`tests`、`examples` 纳入类型检查。

## Planned mapping

| 现有包 | 目标包 |
| --- | --- |
| `contracts`、`abi` | `contracts` |
| `plugin-sdk`、`plugin-host` | `plugins` |
| `control-plane`、`plugin-distribution` | `control-plane` |
| `storage`、`persistence-spi`、`persistence-runtime`、`persistence-sqlite` | `storage` |
| `observability`、`built-in-plugins` | `observability` |
| `runtime`、`workflow`、`decision`、`rule-engine`、`subscriptions`、`cli` | 保持独立 |
| `adapters/*` | 保持独立 |

## Baseline consumers

迁移前旧包名的源码消费者主要分布在：

- `packages/control-plane/src/*`
- `packages/runtime/src/routing.ts`
- `packages/plugin-host/src/*`
- `packages/plugin-distribution/src/*`
- `packages/persistence-runtime/src/*`
- `packages/persistence-sqlite/src/*`
- `packages/adapters/*/src/*`
- `examples/agent-sandbox/src/*`
- `examples/*/src/*`
- `tests/contract/**`、`tests/integration/**`、`tests/routing/**`、`tests/distribution/**`、`tests/compatibility/**`

历史架构计划和审计文档也引用旧包名，但这些文档引用只有在最终架构说明或迁移记录需要同步时才更新，不作为运行时消费者。

## Verification evidence

在任何包移动前，以下命令均通过：

| 命令 | 结果 |
| --- | --- |
| `npm install` | 成功，114 packages added，0 vulnerabilities |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0，所有测试通过 |
| `npm run verify:packages` | exit 0，验证 24 个 package distributions |

后续每个包合并组必须重新执行对应聚焦测试，并在最终任务重新执行完整验证。

## Final implementation evidence

本次迁移按原计划完成，运行时公共符号和行为保持不变：

- `@iar/contracts` 吸收 ABI；`@iar/plugins` 合并 SDK 与 Host；`@iar/storage` 合并 core、SPI、runtime 和 SQLite；`@iar/control-plane` 合并 tenant control-plane 与 distribution；`@iar/observability` 合并 recorder、redaction 和 system plugin。
- 最终 workspace 为 11 个核心包和 6 个 adapter 包；`examples/agent-sandbox` 保持根级组合根，四个插件示例移动到 `examples/plugins/`，examples 未加入 workspace glob。
- 所有活动源码、测试、脚本和公共文档均使用新包入口；未发现旧 `@iar/*` 包名或 `packages/*/src` 越界导入。

最终验证结果：

| 命令 | 结果 |
| --- | --- |
| `npm install` | exit 0，0 vulnerabilities |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0，完整测试集通过 |
| `npm run verify:packages` | exit 0，17 个 package distributions 通过 |
| `npm run demo:fake-plugin` | exit 0，生命周期与 replay 演示通过 |
| `npm run demo:sandbox -- --brain scripted` | exit 0，使用隔离端口 8788 启动并通过 SIGINT 干净退出；默认 8787 被既有进程占用 |
| `openspec validate consolidate-package-boundaries --strict` | exit 0 |
| `git diff --check` | exit 0 |
