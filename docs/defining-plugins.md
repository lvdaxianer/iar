# 定义 Plugin

IAR 的层级固定为 `Plugin > Function > Operation`：Plugin 是发布、生命周期和授权边界；Function 是可被意图识别和路由的业务能力；Operation 是 Function 对外声明的具体动作。

更完整的包边界和统一入口说明见：[Plugin > Function > Operation 架构](./plugin-function-architecture.md) 和[统一入口和包注册](./unified-entry.md)。

业务 Plugin 必须通过 `@iar/plugin` 导出一个完整的 `PluginPackage`。业务 Function 不能脱离 Plugin 单独注册，也不能把 Function 字段继续放在 Plugin Manifest 顶层。

## 1. Plugin 包的组成

| 层级 | 负责内容 | 典型字段 |
| --- | --- | --- |
| Plugin | 包身份、版本、依赖、生命周期、能力上界和策略上界 | `pluginId`、`version`、`capabilities`、`lifecycle`、`policy` |
| Function | 意图识别目标、输入输出 Schema、动作类型和风险等级 | `functionId`、`actionTypes`、`inputSchema`、`outputSchema` |
| Operation | Function 下的可执行或只读动作目录 | `name`、`kind`、`description` |

系统 Plugin 只参与 Hook/订阅等运行时能力，不进入业务 Function 候选，也不注册业务 Function。

## 2. 定义一个 Plugin

Plugin Manifest 只声明包级边界：

```ts
import type { BusinessPluginManifest } from '@iar/contracts';

export const ticketManifest: BusinessPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'ticket-v1',
  pluginKind: 'business',
  scope: 'plugin',
  version: '1.0.0',
  description: '工单能力包',
  capabilities: ['ticket.read', 'ticket.write'],
  lifecycle: { entrypoint: './dist/ticket.js' },
  policy: {
    riskLevel: 'high',
    requiresConfirmation: true,
    allowedCapabilities: ['ticket.read', 'ticket.write']
  },
  dependencies: []
};
```

Manifest 不再包含 `functionId`、`actionTypes`、`operations`、`inputSchema` 或 `outputSchema`。这些字段属于下面的 Function 定义。

## 3. 定义 Function、Operation 和 Handler

```ts
import { SCHEMA_VERSIONS } from '@iar/contracts';
import { defineFunction, definePlugin, type FunctionHandler } from '@iar/plugin';

const ticketCreate = defineFunction({
  definition: {
    schemaVersion: SCHEMA_VERSIONS.function,
    functionId: 'ticket.create',
    version: '1.0.0',
    name: '创建工单',
    description: '创建工单并返回工单编号',
    actionTypes: ['create'],
    capabilities: ['ticket.write'],
    riskLevel: 'high',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false }
  },
  operations: [
    { name: 'create', kind: 'action', description: '提交新工单并返回工单编号' }
  ],
  handler: (async (input, context) => ({
    output: { accepted: true, pluginId: context.pluginId, functionId: context.functionId, input },
    status: 'succeeded'
  })) satisfies FunctionHandler
});

export const ticketPlugin = definePlugin({
  manifest: ticketManifest,
  functions: [ticketCreate]
});
```

`defineFunction` 会校验 Function definition、Operation 目录和 Handler；`definePlugin` 会校验 Function ID 唯一性、Function capability 必须属于 Plugin capability 集合，以及 Plugin/Function 的归属关系。

一个 Plugin 可以包含多个 Function：

```ts
export const ticketPlugin = definePlugin({
  manifest: ticketManifest,
  functions: [ticketQuery, ticketCreate]
});
```

每个 Function 的 Handler 都收到 JSON 输入和只读执行上下文。上下文包含当前真实的 `pluginId`、`functionId`、`runId` 和 `correlationId`；Handler 不能修改注册表、策略或授权边界。

## 4. 统一入口注册

应用只需要把 Plugin 包传给 `@iar/agent`：

```ts
import { createIarAgent } from '@iar/agent';
import { ticketPlugin } from './ticket-plugin.js';

export const iar = createIarAgent({ plugins: [ticketPlugin] });
```

统一入口一次完成校验、原子安装、依赖排序、启用和 FunctionRegistry 构建。任何一个 Plugin 或 Function 失败，整个 Agent 初始化失败，不留下部分生命周期记录或路由索引。

需要直接管理生命周期时使用返回的 `pluginHost`；需要查询当前业务 Function provider 时使用 `functionRegistry`。调用方不再维护 `functionIds`，也不需要逐个手工拼接 Function 与 Plugin 的关系。

## 5. 路由和会话边界

默认路由协议保持 Function-first：

```text
用户输入
  → 意图识别
  → 选择 Function
  → 在 Function 的 enabled Plugin provider 中选择 Plugin
  → PluginHost 最终重验证
  → Policy / confirmation
  → 会话执行 Handler
```

Plugin-first 适配器仍可用于已有场景，但一个 Plugin 的多个 Function 会先按当前语义动作过滤，再在所选 Plugin 内进行 Function 选择。动态候选、未解析计数、确认状态、持久化和会话恢复仍由 IAR 管理。

Pi 只通过 `@iar/pi-bridge` 调用 IAR 会话服务。Pi 不需要知道 Plugin、Function 或 Operation 的内部注册细节，也不需要修改 Pi 源码。

## 6. HTTP/Service 边界的限制

本地业务 Plugin 的 Handler 是不可 JSON 序列化的函数，因此业务包必须通过模块导入和 `@iar/agent` 注册。Fastify/Service API 可以接收可序列化的系统 Plugin Manifest 做生命周期管理；将业务 Manifest 当作远程可执行包提交会被拒绝，这是 fail-closed 行为。

## 7. 红线

- 不在 Plugin Manifest 顶层新增 Function 字段。
- 不注册没有 Plugin 所有权的孤立 Function。
- `action` Operation 必须走确认门禁；只读能力标为 `read`。
- Handler 不读取或修改宿主注册表，不动态扩展 capability。
- 输入、输出和可信 facts 都必须遵守各自 Schema 与大小边界。
- Plugin capability 是 Function capability 的上界，模型和客户端不能动态扩权。
