# Changelog

本项目的所有重要变更都记录在此文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 根级 `LICENSE`（MIT）与全部 workspace 包的 `license`/`description`/`author`/`repository`/`keywords` 元数据。
- GitHub Actions CI：Node.js 24 下依次执行 `npm run lint`、`npm run build`、`npm test`、`npm run verify:packages`。
- 测试覆盖率入口：`npm run test:coverage`（c8，聚合 `node --test` 全量测试）。
- `docs/README.md` 补全 `superpowers/`、`performance/` 与全部测试用例文档索引，并新增文档归档与退役规则。

### Changed

- 包管理统一为 npm，`package-lock.json` 是唯一锁定来源；移除 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml`。
- 合并并归档 6 个已完成的 OpenSpec 变更（`fix-agent-sandbox-tricky-scenarios`、`fix-semantic-thinking-timeout`、`fix-single-session-pending-recovery`、`fix-topic-switch-context`、`fix-workflow-state-context-query`、`recover-semantic-routing-gaps`），补充同步 `bounded-routing`、`continuation-recovery`、`nested-plugin-function-routing` 等主规格。
- 根 README 的架构锚点链接指向恢复为 `docs/架构技术方案/README.md`；实现对齐矩阵的失效源码路径更新为现行包结构。
- 清理 21 个已合并的任务分支与对应 worktree。
- `ActionIdempotencyLedger` 从 `runtime/src/session/` 移到 `runtime/src/execution/`，消除 execution 对 session 的反向目录依赖。
- 路由主路径（nested proposal）收敛为 `routing.ts` 模块级共享实现，`TwoStageRouter` 与 `PluginFirstRouter` 不再互相实例化；架构文档新增 5.7 路由路径矩阵，冻结三条兼容链路的选择顺序契约。
- `run-tests.mjs` 从串行改为有界并发（默认按 CPU 计算，`IAR_TEST_CONCURRENCY` 可覆盖），全量测试时长从约 96s 降至约 28s。
- 架构文档修正 11 章选型表（npm/node:test）与 11.1 包结构块，与现行仓库对齐；`control-plane` 在 README 与架构文档中标注为预览级（尚无宿主消费方）。

## [0.1.0] - 2026-10-26

首个整体发布：Phase 1～6 全部实现并通过端到端验收。

### Added

- 版本化 ABI、Manifest、Function/Plugin 契约与 Schema 校验（`@iar/contracts`）。
- 插件作者 SDK 与 PluginHost（`@iar/plugin`、`@iar/plugins`）：definePlugin / defineFunction、注册、生命周期、Hook、状态事件与订阅分发。
- 独立运行时（`@iar/runtime`）：Function → Plugin 两阶段路由、JEV 优先 / Intent Model 可替换的统一决策后端（同一 `iar.decision/v1` 契约）、Policy Gate、确认范围、权限校验、本地 Workflow 状态机。
- 基于 EventLog 的 BehaviorContext 投影、重放、结构化压缩校验和幂等执行；成功动作的有界公开结果投影为带来源元数据的可信事实，并随 SQLite 快照恢复。
- 每轮模型调用携带当前问题和实时结构化上下文；兜底模型依据可信事实回答或澄清，不重复触发副作用；自然语言顺序指代经有限候选解析，歧义进入有界澄清。
- 存储与持久化（`@iar/storage`）：EventStore、持久化 SPI、异步 SQLite Provider，支持进程重启后的快照恢复。
- 控制面（`@iar/control-plane`）与 CLI（`@iar/cli`）：install / enable / disable / inspect / replay；插件签名分发、版本升级、回滚与多租户边界。
- 适配器：Fastify、Service、Sidecar、PostgreSQL、Temporal（可选 Durable Workflow）、worker/sidecar/container 执行器，以及 `@iar/pi-bridge` Pi 扩展。
- Agent Sandbox 组合根：多会话隔离网页演示、真实模型基线记录、50 场景语义评测与故障恢复演练。
- 869 个测试覆盖契约、重放、路由、安全、服务化、Durable 与分发兼容性。

[Unreleased]: https://github.com/lvdaxianer/iar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lvdaxianer/iar/releases/tag/v0.1.0
