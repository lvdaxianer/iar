# IAR

IAR（Intent Action Runtime）是一个面向可恢复行为执行的 TypeScript 运行时。它把用户意图、Function/Plugin 决策、策略确认、Workflow 执行和事件重放组织在同一套可审计的运行时契约中。

> 当前状态：Phase 1～5 MVP 已实现，并通过全量验证。

## 核心能力

- 版本化 ABI、Manifest、Function/Plugin 契约与 Schema 校验
- 基于 EventLog 的 BehaviorContext 投影、重放、压缩校验和幂等执行
- Function → Plugin 两阶段路由，以及可解释的复合规则和类型化决策
- Policy Gate、确认范围、权限校验和本地 Workflow 状态机
- Fastify API、Service、Sidecar、CLI、PostgreSQL 与 SQLite 适配器
- 插件隔离执行、签名分发、版本升级、回滚和多租户边界
- 可选 Durable Workflow Runtime、结构化脱敏观测和故障恢复演练

## 快速开始

要求 Node.js `>=24`。

```bash
npm install
npm run build
npm test
```

运行 fake plugin 端到端示例：

```bash
npm run demo:fake-plugin
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run lint` | TypeScript 类型检查，不生成构建产物 |
| `npm run build` | 编译全部 workspace 包 |
| `npm test` | 编译并运行完整测试套件 |
| `npm run demo:fake-plugin` | 运行 fake plugin 生命周期与 replay 示例 |

## 项目结构

```text
packages/
├── abi/                  # 跨边界 ABI 与安全序列化
├── contracts/            # 公共契约、Manifest 与 Schema
├── decision/             # 类型化决策与 Decision Provider
├── plugin-host/          # 插件注册、生命周期与执行边界
├── plugin-sdk/           # 插件开发接口
├── rule-engine/          # 复合规则与候选集约束
├── runtime/              # 行为运行时、重放与路由
├── storage/              # EventStore、快照与持久化适配器
├── workflow/             # Policy Gate 与本地 Workflow
└── adapters/             # Fastify、Service、Sidecar、PostgreSQL、Temporal 等适配器
tests/                    # 契约、重放、路由、安全、服务化与故障演练测试
docs/                     # 完整架构说明与实现审计
```

## 设计边界

- Function 决定“做什么”，Plugin 只负责已确定 Function 的具体实现。
- Policy、确认、权限和能力校验必须发生在副作用执行之前。
- EventLog 是可恢复行为状态的事实来源；上下文压缩不能覆盖关键状态。
- 短动作默认使用本地确定性运行时；只有明确的定时器、跨服务或补偿需求才进入 Durable Runtime。
- 插件卸载撤销当前注册但保留历史事件，升级失败时恢复精确的上一版本。

## 文档与验证

- [完整架构与能力边界](docs/README.md)
- [Phase 1～5 最终实现审计](docs/implementation-audits/phase-1-5-final.md)
- [已归档的 OpenSpec 计划](openspec/changes/archive/2026-10-17-iar-five-phase-roadmap/tasks.md)

最终验证结果：`npm run lint`、`npm run build` 通过，`npm test` 为 **237/237 PASS**；Phase 5 的 durable、distribution、compatibility focused tests 为 **56/56 PASS**。
