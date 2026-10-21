# Plugin > Function > Operation 架构

IAR 的公共能力模型固定为三层：

```text
Plugin
└── Function
    └── Operation
```

## 三层职责

| 层级 | 责任 | 典型内容 |
| --- | --- | --- |
| Plugin | 分发、版本、生命周期、依赖和能力上界 | `pluginId`、`version`、`capabilities`、`dependencies`、`policy` |
| Function | 意图识别、路由和执行能力 | `functionId`、Schema、`actionTypes`、风险等级、Handler |
| Operation | Function 内的具体动作目录 | `name`、`kind`、`description` |

Plugin Manifest 只声明包级信息。业务 Function 必须嵌套在 `PluginPackage.functions` 中，不能脱离 Plugin 单独注册，也不能把 Function 字段放回 Manifest 顶层。

## 包边界

```text
@iar/contracts  可序列化契约、Schema、版本和错误码
@iar/plugin     插件作者入口：definePlugin / defineFunction
@iar/plugins    PluginHost、生命周期和 Function provider 索引
@iar/runtime    独立意图/动作运行时：bootstrap、intent、execution、observability、session
@iar/subscriptions  Hook/StateEvent 共享订阅边界
@iar/storage    持久化 SPI、SQLite runtime 和可替换存储入口
@iar/control-plane  租户控制面和插件分发
@iar/cli        CLI 产品入口
@iar/pi-bridge  Pi 与 IAR 会话服务之间的适配边界
```

HTTP、Service、Sidecar、PostgreSQL、Temporal 和隔离执行器均位于 `packages/adapters/`，不进入 runtime core。

插件作者只需要从 `@iar/plugin` 构造完整包：

```ts
import { defineFunction, definePlugin } from '@iar/plugin';

const query = defineFunction({
  definition: {
    functionId: 'ticket.query',
    version: '1.0.0',
    name: '查询工单',
    description: '查询工单状态',
    actionTypes: ['query'],
    capabilities: ['ticket.read'],
    riskLevel: 'low',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false }
  },
  operations: [{ name: 'query', kind: 'read', description: '查询工单' }],
  handler: async (input, context) => ({
    status: 'succeeded',
    output: { input, pluginId: context.pluginId, functionId: context.functionId }
  })
});

export const ticketPlugin = definePlugin({
  manifest: {
    pluginId: 'ticket-system',
    pluginKind: 'business',
    scope: 'plugin',
    version: '1.0.0',
    description: '工单能力包',
    capabilities: ['ticket.read'],
    dependencies: []
  },
  functions: [query]
});
```

`defineFunction` 校验 Function、Operation 和 Handler；`definePlugin` 校验 Function ID 唯一性、能力闭包和 Plugin 所有权。任何一个 Function 失败都会拒绝整个包，不留下半个注册结果。

## 生命周期和索引

`PluginHost` 是 Plugin 生命周期的唯一权威。安装时先完整校验包，再按依赖排序并原子写入 Plugin 记录；启用、禁用和卸载会同时影响包内全部 Function。

`FunctionRegistry` 只从 Host 当前记录派生 `functionId -> Plugin providers`，不拥有第二份授权状态。统一 Runtime 返回的 Registry 绑定当前 Host，因此后续生命周期变化不会留下过期的 Function 候选。

系统 Plugin 可以参与显式 Hook/订阅生命周期，但不能注册业务 Function，也不会出现在意图识别候选中。

## 意图识别和动态路由

层级归属是 Plugin-first，默认运行时决策顺序仍是 Function-first：

```text
用户输入
  → 会话上下文和规则边界
  → Function 决策
  → 当前 Function 的 Plugin provider 决策
  → PluginHost 最终重验证
  → Operation / Policy / confirmation
  → Function Handler
```

模型只能在当前有限候选中选择，不能新增 Function、Plugin、能力或权限。低置信度、候选失效、禁用 Plugin、ownership 不匹配和能力越界继续按原有 fail-closed 语义处理。

Plugin-first 兼容场景仍支持一个 Plugin 内多个 Function：先按语义动作过滤，再把该包内的有限 Function 集合交给 Function 决策。

## 会话和 Pi 边界

IAR 是会话状态和动态路由状态的唯一来源。普通入口、流式入口、确认、持久化恢复和动态候选共用同一个 Session 状态机。

Pi 通过 `@iar/pi-bridge` 传递会话输入和结果，Pi 不管理 IAR Plugin/Function 注册，也不创建第二套会话。这样可以在不修改 Pi 核心源码的情况下接入意图识别和动态路由。

业务 Handler 无法通过 JSON HTTP 请求传输，因此本地业务 Plugin 使用模块导入；Fastify/Service 边界仅处理可序列化的系统 Manifest 和生命周期操作。
