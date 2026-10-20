# 定义 Function

Function 是 IAR 两阶段路由的**第一阶段边界**：语义抽取把用户输入归一到某个 `functionId`，路由先选 Function、再在其内部选择 Plugin。本文说明 Function 的契约结构、它与 Plugin 的关系，以及在 agent sandbox 中新增一个 Function 的完整步骤。

## 1. Function 在链路中的位置

```
用户输入
  → 语义抽取（intent 即 functionId，如 ticket.create）
  → 阶段一：Function 路由（规则过滤 + 决策模型从候选 Function 中选择）
  → 阶段二：Plugin 路由（在该 Function 已启用的插件中选择）
  → 策略/确认 → Workflow 执行 → 事件投影
```

Function 回答的问题是「**这是哪个业务能力域**」，而不是「具体执行什么」。同一句话如果涉及多个 Function，由路由规则或模型决策收敛到一个。

## 2. 契约定义（`@iar/contracts`）

`FunctionDefinition` 描述 Function 的路由与数据边界：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 契约版本（`iar.function/v1`） |
| `functionId` | 稳定标识，插件归属与路由的硬边界，如 `ticket.create` |
| `version` | Function 字段的解释版本 |
| `name` | 宿主展示名 |
| `description` | 供有限候选解释用的描述 |
| `actionTypes` | 该 Function 可承载的固定动作集合，只能是 `query`/`create`/`update`/`delete`/`transfer`/`execute` 的子集，模型不能动态创造动作类型 |
| `inputSchema` / `outputSchema` | Function 数据边界的 JSON Schema |
| `capabilities` | 路由与策略过滤使用的能力标签 |
| `riskLevel` | `low` / `medium` / `high` / `critical` |

## 3. Function 与 Plugin 的关系

- **一个 Function 挂一个或多个 Plugin**。多插件共存支持同域内的实现替换（灰度、版本升级、回滚）；sandbox 演示环境是 1:1。
- Plugin 通过 manifest 的 `functionId` 字段声明归属（`scope: 'function'` 强制这一边界）。
- Function 的候选插件集由 `PluginHost.candidates(functionId)` 给出，只有已安装的插件才会进入阶段二候选。

## 4. sandbox 中的落地：新增 Function 的四步

以十个子系统之一 `ticket.create`（工单支持）为例。

### 第 1 步：声明 Function 标识

在 `examples/agent-sandbox/src/functions/index.ts` 的 `sandboxFunctionIds` 中加入 `ticket.create`。该列表在创建宿主时传入：

```ts
const host = new PluginHost({ functionIds: sandboxFunctionIds });
```

未在 `functionIds` 中声明的标识不会被路由候选。

### 第 2 步：编写宿主侧能力描述（catalog）

在同一个文件的 `sandboxFunctionCatalog` 中登记 `SandboxFunctionDescriptor`：

```ts
'ticket.create': {
  functionId: 'ticket.create',
  name: '工单支持',
  pluginId: 'ticket-create-v1',
  description: '工单进度查询与工单创建',
  operations: ticketCreateOperations,
  defaultOperation: 'create'
}
```

catalog 是宿主侧元数据，供四处消费：

- **确认策略**：`session-helpers.ts` 按 `operations[].kind` 判定 `read` 免确认、`action` 沿用插件 policy；
- **语义提示词**：操作目录会进入模型上下文，约束可抽取的 `slots.operation` 范围；
- **兜底回复**：描述能力边界；
- **调试面板**：中文名与操作展示。

### 第 3 步：定义操作目录

每个 Function 显式声明操作目录（`PluginOperation` 形状）：

```ts
export const ticketCreateOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索工单支持知识库，返回相关度最高的 3 条说明' },
  { name: 'progress', kind: 'read', description: '按工单号查询工单的流转节点与处理进展' },
  { name: 'create', kind: 'action', description: '提交新工单并返回工单编号' }
];
```

`kind` 是安全开关：`read` 直接执行，`action` 必须走确认流。`defaultOperation` 是模型未给出 operation 时的回落点。

### 第 4 步：实现并注册归属插件

见 [定义 Plugin](./defining-plugins.md)。插件 manifest 的 `functionId` 必须与 catalog 键一致，然后追加进 `allSandboxPlugins` 列表完成安装。

## 5. 让模型认识这个 Function

`sandbox` 的语义提示词（`model-input-transport.ts` 的 `SEMANTIC_SYSTEM_PROMPT`）按 catalog 生成 intent 清单：每个 Function 一段「intent 名 + 操作与槽位说明」。新增 Function 后要同步提示词（或如当前实现一样从 catalog 动态注入 Function 描述），否则模型抽不出这个 intent，路由永远到不了它。

语义抽取的固定约定：

- `intent` 取值即 `functionId`，语义层不允许发明清单之外的 intent；
- `action` 只能是 `query`/`create`/`update`/`delete`/`transfer`/`execute`/`unknown` 之一；
- 咨询类问题不给 `slots.operation`，动作请求才给。

## 6. 检查清单

新增 Function 时逐项确认：

- [ ] `sandboxFunctionIds` 已加入新标识
- [ ] `sandboxFunctionCatalog` 已登记描述（name/description/operations/defaultOperation）
- [ ] 操作目录的 `kind` 标注正确（read 还是 action）
- [ ] 归属插件 manifest 的 `functionId` 一致，且已加入 `allSandboxPlugins`
- [ ] 语义提示词的 intent 清单已覆盖（静态或动态注入）
- [ ] 知识库（如有）在 `knowledge/bases/<functionId>.json` 就位并被检索函数引用
- [ ] 单轮单意图验证：一句典型话术能路由到该 Function；一句咨询话术不被误判为 action

## 7. 常见陷阱

- **intent 拼写不一致**：提示词里的 intent 名、catalog 键、manifest `functionId` 三处必须完全相同，一处漂移即路由失效。
- **操作 kind 标错**：把 `create` 标成 `read` 会绕过确认直接执行副作用——这是最危险的一类错误。
- **defaultOperation 指向 action**：operation 缺失时回落到写操作会让咨询类问法误入确认流（当前实现已要求模型必须给出 operation）。
