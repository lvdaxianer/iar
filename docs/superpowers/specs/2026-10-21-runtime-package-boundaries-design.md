# IAR Runtime 包边界收敛设计

## 1. 背景与目标

当前 IAR 的代码已经有明确的运行时、插件、持久化和适配器职责，但历史上按
实现阶段拆出了较多 workspace 包。目标不是把所有目录合并成一个大包，而是让
每个可发布包都对应一个真实的使用、替换或部署边界。

最终把 `@iar/runtime` 定位为可以脱离 Pi、HTTP 和具体数据库独立使用的
意图/动作运行时；Pi、数据库、durable execution 和服务传输继续通过 adapter
接入。

## 2. 目标目录

```text
packages/
├── contracts/              # @iar/contracts：稳定 JSON 契约和 Schema
├── plugin/                 # @iar/plugin：插件作者 SDK
├── plugins/                # @iar/plugins：PluginHost 和 FunctionRegistry
├── runtime/                # @iar/runtime：独立 IAR 运行时
│   ├── src/bootstrap/      # 原 agent 装配入口
│   ├── src/intent/         # 原 decision、rule-engine
│   ├── src/execution/      # 原 workflow 和动作执行
│   ├── src/observability/  # 原 observability
│   └── src/session/        # 上下文、重放、压缩和幂等
├── subscriptions/          # 跨包 Hook/StateEvent 边界
├── storage/                # 持久化 SPI、SQLite 和 runtime loader
├── control-plane/          # 可选控制面和插件分发
├── cli/                    # 命令行入口
└── adapters/
    ├── pi/                 # @iar/pi-bridge
    ├── fastify/            # HTTP adapter
    ├── service/            # Service API
    ├── sidecar/            # Sidecar transport
    ├── postgres/           # PostgreSQL storage adapter
    ├── temporal/           # Durable workflow adapter
    └── executors/          # worker/sidecar/container executor
```

保留 `plugins`、`subscriptions` 和 `storage`，因为它们跨越多个消费者并且本身
就是公共或可替换边界。`agent`、`decision`、`rule-engine`、`workflow` 和
`observability` 只服务运行时主链路，收敛为 runtime 内部目录。

## 3. 对外使用方式

独立运行时：

```ts
import { createIarRuntime } from '@iar/runtime';
import { definePlugin } from '@iar/plugin';

const iar = createIarRuntime({
  plugins: [myPlugin],
  decisionProvider
});
```

Pi 集成：

```text
Pi → @iar/pi-bridge → IAR Runtime
```

`@iar/pi-bridge` 只负责 Pi extension、协议和请求转发，不拥有 IAR 的插件、
路由或会话状态。

持久化和执行后端：

```text
@iar/runtime
  ├── @iar/storage                 # SQLite 或 SPI
  ├── @iar/adapters-postgres       # PostgreSQL
  └── @iar/adapters-temporal       # Durable execution
```

## 4. 迁移顺序

1. 建立 runtime 独立入口和包分发 smoke test。
2. 迁移 decision、rule-engine 到 runtime/intent。
3. 迁移 workflow 到 runtime/execution。
4. 迁移 observability 到 runtime/observability。
5. 迁移 agent 初始化入口，导出 `createIarRuntime`，短期提供
   `createIarAgent` deprecated alias。
6. 更新 adapters、examples、tests、project references 和 package manifests。
7. 删除旧 workspace 包，更新文档和最终发布验证。

## 5. 不变约束

- 不改变 `Plugin > Function > Operation` 模型。
- 不改变 Function-first 两阶段路由和 fail-closed 语义。
- 不改变 Pi Bridge 协议、会话映射、展示隔离和确认/取消行为。
- 不改变持久化格式、错误码、Schema 版本和安全边界。
- 业务 Handler 仍在进程内通过 Plugin 包注册，不通过 JSON 传输。
