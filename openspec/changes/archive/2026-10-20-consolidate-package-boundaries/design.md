# Design

## Context

当前仓库使用 npm/pnpm workspace 管理 18 个核心包和 6 个适配器包。核心包全部是私有包，多个包只服务于同一条内部实现链路；例如 `persistence-spi`、`persistence-runtime` 和 `persistence-sqlite` 共同构成会话持久化接入，`plugin-sdk` 和 `plugin-host` 共同构成插件核心，`abi` 目前主要由 `control-plane` 使用。

本次设计只调整物理包边界和源码目录，不改变已有 TypeScript API 的语义、运行时状态、协议字段、错误码、持久化格式、插件生命周期或测试行为。逻辑职责继续通过包内子目录表达，独立 workspace 包只保留稳定的发布、可选依赖或部署边界。

## Goals / Non-Goals

**Goals:**

- 将同一内部实现链路收敛为较少的 workspace 包，降低 manifest、构建引用和导出路径维护成本。
- 保留清晰的逻辑子目录，使合并后的包仍能按 SDK、Host、SPI、Provider、分发和观测实现定位源码。
- 让 `examples` 成为真实消费者：示例只依赖包的公开入口，不引用 `packages/*/src` 内部路径。
- 保留适配器的可选依赖和部署边界，避免把 Fastify、PostgreSQL、Temporal 等基础设施依赖引入核心包。
- 通过分组提交和每组验证，保证每一步都可以独立回滚。

**Non-Goals:**

- 不合并 `runtime`、`workflow`、`decision` 和 `rule-engine` 的职责。
- 不把 `adapters/*` 合并成单个包。
- 不增加旧私有包名的运行时兼容层。
- 不改变公开协议、数据模型、错误码、执行语义或持久化迁移策略。
- 不把 `agent-sandbox` 提前迁移为正式 `apps` 应用。

## Decisions

### 1. 采用包内子目录代替过早的 workspace 拆分

目标包映射如下：

| 目标包 | 合并来源 | 包内子目录 |
| --- | --- | --- |
| `@iar/contracts` | `contracts`、`abi` | `contracts/`、`abi/` |
| `@iar/plugins` | `plugin-sdk`、`plugin-host` | `sdk/`、`host/` |
| `@iar/control-plane` | `control-plane`、`plugin-distribution` | `control-plane/`、`distribution/` |
| `@iar/storage` | `storage`、`persistence-spi`、`persistence-runtime`、`persistence-sqlite` | `core/`、`spi/`、`runtime/`、`sqlite/` |
| `@iar/observability` | `observability`、`built-in-plugins` | `core/`、`system-plugin/` |

选择包内子目录而不是把源码全部平铺，是为了保持职责可发现性，并降低未来重新拆包时的迁移成本。选择合并而不是继续保留独立私有包，是因为这些包当前没有独立发布、独立版本或独立部署的要求。

替代方案是保持现有包数量，只改文档；该方案不能降低构建和依赖维护成本，因此不采用。另一方案是把所有核心包合成一个 `core` 包；该方案会隐藏插件、存储和观测的可选边界，暂不采用。

### 2. 适配器继续保持独立包

`packages/adapters/*` 继续独立，因为它们承载外部依赖和部署模式：Fastify、PostgreSQL、Temporal、Sidecar、Service 和 Executor 的安装成本、运行环境和生命周期不同。核心包不得因为合并而直接依赖这些适配器。

### 3. `examples` 位于仓库根目录

`examples/agent-sandbox` 继续作为完整可运行示例，示例插件统一放在 `examples/plugins/`。不创建 `packages/examples`，因为示例是包的消费者和集成验证，而不是可复用平台能力。

示例的依赖只允许指向 workspace 包公开入口；如果某个示例必须引用内部源码，先补齐公开导出，再迁移 import，不保留跨目录源码引用。

### 4. 采用分组迁移和独立提交

迁移顺序固定为：基础契约 → 插件核心 → 存储 → 控制面与观测 → examples → workspace/文档清理。每组先完成文件移动和 import 更新，再执行聚焦检查和全量构建；每组通过验证后单独提交。

由于当前集成分支存在与本任务无关的 web 未提交改动，所有实现、测试和提交都在专用 worktree 中完成，集成时只合并本任务提交。

## Risks / Trade-offs

- **[Risk] 包内相对路径和 TypeScript project reference 更新不完整** → 每组迁移后用 `rg` 搜索旧包名和旧源码路径，并运行 `npm run lint`、`npm run build`。
- **[Risk] 示例或测试依赖旧包名** → 先建立旧包名消费者清单，按目标包映射逐项替换；最终要求旧包名只出现在迁移记录或归档文档中。
- **[Risk] 合并存储实现时混淆通用 Store 与 Session Provider** → 用 `core/`、`spi/`、`runtime/`、`sqlite/` 子目录保持协议、加载器和实现的独立职责，并保留现有测试分组。
- **[Risk] 合并后意外引入可选基础设施依赖** → 适配器包不移动；目标核心包的 `dependencies` 只保留当前核心依赖和必要的运行时库。
- **[Risk] 文档先于代码描述新结构导致不一致** → 文档更新放在最后一组，完成构建和分发校验后再同步架构树和 README。
- **[Trade-off] 私有包的旧入口不再保留** → 当前仓库内所有消费者一起迁移；如果未来需要外部插件 SDK，再以明确的发布需求重新设计兼容包，而不是现在增加过渡层。

## Migration Plan

1. 在 `master` 集成分支创建专用任务分支和 worktree，记录 `SOURCE_BRANCH=master`。
2. 完成基线清单，确认旧包名、公开入口、测试入口和示例入口。
3. 按任务顺序迁移五组包边界，每组修改 manifest、源码目录、入口导出、测试 import 和 TypeScript 引用。
4. 移动示例插件并修正所有示例依赖，使其只使用公开包入口。
5. 更新 workspace 配置、分发校验、根 README、架构文档和相关计划索引。
6. 执行 `npm run lint`、`npm run build`、`npm test`、`npm run verify:packages`、fake plugin demo 和 sandbox demo。
7. 如果某组迁移失败，回滚该组提交；已通过的前序组保持不变。若发现真实的外部发布需求，暂停后续合并并重新评估 SDK/ABI 的独立包边界。

## Open Questions

无。是否把 `plugin-sdk` 独立发布已经明确作为未来需求触发条件，不影响本次内部包收敛计划。
