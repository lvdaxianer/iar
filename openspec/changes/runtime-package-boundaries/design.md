# Design

## Context

See `proposal.md` for the motivation and scope. 当前 workspace 的依赖关系表明，
`agent`、`decision`、`rule-engine`、`workflow` 和 `observability` 都服务于
运行时主链路；`plugins`、`subscriptions` 和 `storage` 则被控制面、服务适配器、
执行器或持久化适配器共享。Pi Bridge 已经是独立的协议/宿主集成边界，不应被
打进核心 runtime。

目标结构为：

```text
@iar/contracts       稳定 JSON 契约、Schema、版本和错误码
@iar/plugin          插件作者 SDK
@iar/plugins         PluginHost、FunctionRegistry、生命周期
@iar/runtime         独立 IAR 意图/动作运行时
@iar/subscriptions   跨包 Hook/StateEvent 订阅边界
@iar/storage         持久化 SPI、内置 SQLite 和存储运行时
@iar/control-plane   可选的租户控制面与插件分发
@iar/cli             命令行产品入口
@iar/adapters/*      Pi、HTTP、数据库、durable、隔离执行适配器
```

`@iar/runtime` 内部目录承载 `decision`、`rule-engine`、`workflow`、
`observability` 和 `agent` 的实现；源码仍按职责分目录，但不再为它们分别
建立可发布 workspace 包。

## Goals / Non-Goals

**Goals:**

- 让 `@iar/runtime` 成为可直接安装的独立意图/动作运行时，默认使用进程内
  Plugin 和 Decision Provider，不要求 Pi、HTTP、PostgreSQL 或 Temporal。
- 让 runtime 的公共入口、类型声明和打包内容可以从安装包根目录验证。
- 保留 `@iar/plugin`、`@iar/plugins`、`@iar/storage` 和
  `@iar/subscriptions` 的稳定职责与替换边界。
- 保留 `@iar/pi-bridge` 的协议、会话映射、展示隔离和故障策略。
- 将旧包的源码迁移限制在包边界和 import 变化，不改变路由、生命周期、
  持久化格式、错误码或安全语义。

**Non-Goals:**

- 本次不新增 Pi 功能、HTTP API、数据库 Provider 或 Temporal 语义。
- 本次不把业务 Plugin Handler 改造成 JSON 远程执行协议。
- 本次不改变 `Plugin > Function > Operation` 模型和 Function-first 路由。
- 本次不移除 `control-plane` 或 adapter；它们仍是独立可选能力。

## Decisions

### 1. 将 `@iar/runtime` 作为独立产品入口

`@iar/runtime` 从 `private` 包改为可发布包，并在根入口提供
`createIarRuntime`。入口负责装配 PluginHost、FunctionRegistry、决策、规则、
执行和会话运行时；它不主动加载 Pi 或外部基础设施。

选择它而不是新增 `@iar/iar`，是因为现有 `runtime` 已经承载路由、上下文、
重放和幂等门禁，新增顶层包只会再增加一层发布概念。`@iar/agent` 的统一
装配能力迁移到 runtime；最终消费者改为从 `@iar/runtime` 导入。

### 2. 收敛实现，不收敛所有公共替换边界

以下源码移动到 `packages/runtime/src/` 的子目录：

| 旧包 | runtime 子目录 | 原因 |
| --- | --- | --- |
| `agent` | `bootstrap/` | 只负责运行时装配，不是独立领域产品 |
| `decision` | `intent/decision/` | 只服务 runtime 决策链路 |
| `rule-engine` | `intent/rules/` | 只服务有限候选生成 |
| `workflow` | `execution/` | 执行语义由 runtime 统一拥有，Temporal 只适配接口 |
| `observability` | `observability/` | 观测写入属于 runtime 横切能力 |

以下包保留：

- `plugins`：PluginHost 和 FunctionRegistry 是插件生命周期的公共边界，
  `@iar/plugin` SDK 当前也依赖它。
- `subscriptions`：storage、executors 和 observability/runtime 共享事件订阅，
  合并后会迫使基础设施依赖完整 runtime。
- `storage`：持久化 SPI 和 SQLite 是可替换基础设施边界，PostgreSQL 通过
  adapter 实现，不进入 runtime 核心。

### 3. Pi Bridge 只做宿主适配

`@iar/pi-bridge` 保持独立，内部只包含 Pi extension、协议和 HTTP client。
Pi 通过 Bridge 调用 IAR；Bridge 不创建第二个 PluginHost、FunctionRegistry 或
会话状态机。Pi 的输入处置、展示隔离和确认/取消路径继续由现有协议测试保护。

### 4. Adapter 按可替换基础设施分类

```text
宿主适配：@iar/pi-bridge
服务传输：@iar/adapters-fastify / @iar/adapters-service / @iar/adapters-sidecar
持久化：  @iar/adapters-postgres
执行：    @iar/adapters-temporal / @iar/adapters-executors
```

这些包可以依赖 runtime 或 storage 的公共入口，但 runtime 不反向依赖它们。

### 5. 使用迁移期兼容别名，最终移除旧包入口

runtime 在迁移期导出 `createIarAgent` 的 deprecated alias，保证同一代码库内
可以先迁移实现和测试，再切换示例与文档。`@iar/agent` 包本身在最终任务中
从 workspace 移除；发布迁移说明明确将导入改为 `@iar/runtime`。

## Risks / Trade-offs

- [公共入口 breaking change] → 先增加 runtime 根入口和兼容 alias，再批量迁移
  测试、examples、adapter；发布检查拒绝旧包名残留。
- [源码移动引入循环依赖] → 先固定依赖方向：contracts → plugin/plugins /
  subscriptions/storage → runtime → control-plane/adapters；每次移动后执行
  TypeScript project references 和聚焦测试。
- [运行时包体变大] → 只把运行时实现放入 runtime；Postgres、Temporal、Fastify
  和 Pi 保持 adapter，避免引入外部技术依赖。
- [历史文档引用旧包] → 运行代码、测试和当前架构文档必须迁移；历史审计和
  已归档计划保留原始事实，并在新迁移文档中标注其历史状态。
- [迁移中途发布状态不一致] → 每个迁移任务保持可构建、可验证，并在任务提交
  中同时更新 manifest、project reference、入口和测试；失败时回滚到上一个
  已验证的包边界，不修改持久化数据。

## Migration Plan

1. 记录当前 20 个 package manifest、依赖图、入口和全量验证基线。
2. 在 `runtime` 中先建立 `createIarRuntime`、兼容 alias 和 standalone smoke test。
3. 逐组迁移 `decision`/`rule-engine`、`workflow`、`observability` 和 `agent`
   的源码，更新 project references、manifest 和公共入口。
4. 更新 control-plane、service、executors、Temporal、examples 和 tests 的
   公共包导入；保持 Pi Bridge 协议测试不变。
5. 删除旧 workspace manifests，更新发布验证和当前架构文档。
6. 执行 lint、build、全量 test、package distribution、Pi demo 和相关 demos；
   通过后再归档 OpenSpec change。

回滚策略是按任务提交反向回退包边界迁移；不执行数据库迁移，不修改用户会话
数据或协议版本，因此回滚不需要数据转换。

## Open Questions

无。`@iar/runtime` 的独立入口、保留包和 adapter 分类已经足以确定任务拆分。
