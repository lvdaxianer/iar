# 定义 Plugin

Plugin 是 Function 内部的**具体实现**：它声明自己归属哪个 Function、能做什么操作、需要什么能力与策略，并提供真正执行逻辑的 Handler。本文逐字段讲解 `FunctionPluginManifest`，说明 Handler 契约与可信事实声明，并给出从注册到执行的完整链路。

## 1. Plugin 的两种形态

| 形态 | `pluginKind` / `scope` | 用途 |
| --- | --- | --- |
| 业务插件 | `function` / `function` | 参与业务路由，必须声明唯一 `functionId` 归属 |
| 系统插件 | `system` / `runtime` | 通过 Hook/订阅运行（如持久化订阅桥），不进入业务候选 |

本文重点讲业务插件。

## 2. Manifest：逐字段详解

以 sandbox 的工单插件为实例（`examples/agent-sandbox/src/functions/ticket-create.ts`）：

```ts
export const ticketCreateManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',                    // 宿主兼容性协商
  schemaVersion: 'iar.plugin-manifest/v1',     // 字段演进版本
  pluginId: 'ticket-create-v1',                // 注册表稳定标识
  pluginKind: 'function',
  scope: 'function',
  functionId: 'ticket.create',                 // 归属 Function（硬边界）
  version: '1.0.0',                            // 固定执行与回滚的版本
  description: '工单支持插件，提供工单进度查询与工单创建的确定性模拟',
  actionTypes: ['query', 'create'],            // 可承载的固定动作集合
  inputSchema: sandboxInputSchema(),           // 调用边界 JSON Schema
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/ticket-create.js' },
  policy: {                                    // 安装时固定的策略元数据
    riskLevel: 'high',
    requiresConfirmation: true,
    allowedCapabilities: ['ticket.read', 'ticket.write']
  },
  dependencies: []                             // 确定性加载排序
};
```

安装时 `PluginHost.install` 会做契约校验（`additionalProperties: false`，多余字段直接拒绝），校验关系还包括：`scope: 'function'` 时 `functionId` 必须在宿主声明的 `functionIds` 中。

关键字段的语义：

- **`operations`（可选但推荐）**：操作描述目录 `{ name, kind: 'read'|'action', description }`。它是运行时不维护业务目录原则的落点——插件自己声明能做什么，宿主据 `kind` 决定确认策略，语义模型据 `description` 理解能力边界。
- **`policy.riskLevel` + `requiresConfirmation`**：安装时固化，运行中不可被模型或客户端改写。sandbox 约定：`action` 类操作沿用此 policy（高风险 + 需确认），`read` 类操作强制降级为低风险免确认（见 `session-helpers.ts` 的 `sandboxOperationKind`）。
- **`capabilities` / `allowedCapabilities`**：能力不能由模型动态扩展；Workflow 执行时以插件声明的能力集合做授权校验。
- **`lifecycle.entrypoint`**：宿主按此入口加载插件代码；不可信插件可走 Worker/Sidecar/容器路径执行。

## 3. Handler：执行契约

`@iar/plugin-sdk` 定义的最小边界：

```ts
type PluginHandler = (
  input: JsonValue,                  // 只接收 JSON 输入
  context: PluginHandlerContext      // 只读：pluginId/functionId/runId/correlationId
) => Promise<PluginHandlerResult>;

type PluginHandlerResult = {
  output: JsonValue;                          // 必须 JSON 可序列化
  status: 'succeeded' | 'failed';
  errorCode?: string;                         // 失败路径的稳定审计码
};
```

注册对象把声明与实现绑定：

```ts
export const ticketCreatePlugin: PluginRegistration = {
  manifest: ticketCreateManifest,
  handler: ticketCreateHandler
};
```

### 统一输入形状

sandbox 十个插件共享 fail-closed 的输入解析（`functions/common.ts`）：

```
{ operation?: string, query?: string, params?: Record<string, string> }
```

- 任何未知字段、类型不符、越界（operation>60 字符、query>500、param 值>200）都整体拒绝；
- `operation` 缺省时由 Handler 按 `query` 关键词在 read 操作内推断默认值。

业务插件可以定义自己的 inputSchema——统一形状只是 sandbox 的约定，不是 IAR 的强制。

### 成功/失败的返回约定

用 `succeed` / `fail` 构造结果：

```ts
return succeed('create', {
  receipt: ticketId,
  ticketId,
  title, priority, status: 'created',
  summary: `工单已创建并进入分诊队列，标题「${title}」，优先级 ${priority}`
}, { receipt: ticketId, ticketId, priority, status: 'created' });
```

- `succeed(operation, payload, declaredFacts)`：`payload` 全量返回给回复生成；第三参是**可信事实声明**（见下节）。
- `fail('ticket.not_found')`：稳定错误码进审计，回复模型向用户解释。

## 4. 可信事实：多轮记忆的关键

`succeed` 的第三参声明本次执行产生的可信事实。运行时只接受**短小 JSON 原子值**（字符串≤上限/数字/布尔/null、键名受模式约束、数量有限），投影进 `BehaviorContext.facts` 并随 SQLite 快照恢复。

这带来两个直接能力（见 [测试用例](./agent-sandbox-test-cases.md) 的场景 1/2/5）：

1. **追问回答**：用户问「刚才工单编号是多少」，事实里有 `ticketId=verified`，回答模型直接引用；
2. **槽位继承**：多轮「改成每秒 200」缺 target 时，会话层从 facts 确定性回填（`session-helpers.ts` 的 `inheritFactParams`）。

**只公开该公开的**：把大对象塞进 facts 会膨胀模型上下文并泄漏内部结构；只声明 receipt/ticketId/status 这类用户会再引用的标识。

## 5. 从注册到执行的完整链路

```
PluginRegistration (manifest + handler)
  → PluginHost.install(registration)     契约校验 + 登记（installed 状态）
  → PluginHost.enable(pluginId)          进入候选集（enabled 状态）
  → 路由命中 functionId + pluginId
  → PluginHost.resolveCandidate 校验归属与状态
  → Workflow.execute（read 直接执行 / action 先确认）
  → SyncPluginBridge 在 worker 线程调用 handler(input, context)
  → PluginHandlerResult → ActionResult → 事件投影 + facts 提取
```

sandbox 的安装入口在 `session-dependencies.ts` 的 `createSandboxPluginHost`：逐个 `install` + `enable`，任何一步失败整个会话拒绝启动（不允许半初始化）。

## 6. 最小完整示例

一个只读查询插件的全部代码：

```ts
import type { FunctionPluginManifest } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { fail, succeed } from './common.js';

export const pingManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'example-ping-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'example.ping',
  version: '1.0.0',
  description: '示例插件：返回服务存活状态',
  actionTypes: ['query'],
  operations: [{ name: 'status', kind: 'read', description: '查询示例服务是否存活' }],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { accepted: { const: true } }, required: ['accepted'] },
  lifecycle: { entrypoint: './dist/.../example-ping.js' },
  policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['example.read'] },
  dependencies: []
};

export const pingHandler: PluginHandler = async (input) => {
  return succeed('status', { alive: true, summary: '示例服务存活' }, { alive: true });
};

export const pingPlugin: PluginRegistration = { manifest: pingManifest, handler: pingHandler };
```

然后按 [定义 Function](./defining-functions.md) 的清单把 `example.ping` 接进 `functionIds`、catalog 与语义提示词。

## 7. 红线与最佳实践

- **Handler 不持有信任**：输入一律按不可信 JSON 解析（fail-closed），上下文只读，不能反向修改注册表。
- **副作用声明为 action**：凡是有写操作的 operation，`kind` 必须标 `action`；标 `read` 等于绕过确认机制。
- **错误码稳定**：`errorCode` 用于审计与重试分类，改名会破坏下游处理。
- **facts 只放原子值**：数组/对象不进可信事实；键名用稳定标识（`TRUSTED_FACT_KEY_PATTERN`）。
- **入口指向构建产物**：`lifecycle.entrypoint` 是宿主加载的真实路径，sandbox 指向 `dist/` 下的编译输出，改源码后需重新构建。
- **发布形态**：对外分发走 `plugin-distribution` 的签名打包与版本升级/回滚通道，manifest 即分发的信任根。
