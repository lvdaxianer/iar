# 定义 Function

Function 是 IAR 意图识别和路由的能力单元。它回答“用户想使用哪项能力”，Plugin 则回答“由哪个已启用实现提供这项能力”。Function 必须嵌套在 Plugin 包中，不能作为全局孤立注册项存在。

包依赖、生命周期和应用导入边界见：[Plugin > Function > Operation 架构](./plugin-function-architecture.md) 和[统一入口和包注册](./unified-entry.md)。

## 1. Function 在路由中的位置

```text
用户输入
  → 意图识别得到 functionId
  → Function 规则和模型选择
  → 读取该 Function 的 Plugin providers
  → Plugin 规则和模型选择
  → ownership / capability / policy 重验证
  → Operation / confirmation / Handler
```

因此新包模型是 `Plugin > Function > Operation`，但默认决策顺序仍然是 `Function → Plugin`。这是层级归属和运行时路由顺序的明确区分。

## 2. FunctionDefinition

Function definition 通过 `@iar/plugin` 注册：

```ts
const knowledgeQuery = defineFunction({
  definition: {
    schemaVersion: 'iar.function/v1',
    functionId: 'knowledge.query',
    version: '1.0.0',
    name: '知识查询',
    description: '查询当前 Plugin 提供的知识库',
    actionTypes: ['query'],
    capabilities: ['knowledge.read'],
    riskLevel: 'low',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false }
  },
  operations: [
    { name: 'search', kind: 'read', description: '检索知识库并返回摘要' }
  ],
  handler: async () => ({ output: { found: true }, status: 'succeeded' })
});
```

关键字段含义：

| 字段 | 作用 |
| --- | --- |
| `functionId` | 意图、规则、路由和最终 ownership 校验使用的稳定标识 |
| `actionTypes` | 允许的固定语义动作集合，模型不能创造新动作 |
| `inputSchema` / `outputSchema` | Handler 输入和输出的 JSON 边界 |
| `capabilities` | 路由与策略使用的能力标签，必须是 Plugin capability 的子集 |
| `riskLevel` | 当前 Function 的风险等级，供策略和确认流程使用 |
| `operations` | Function 能执行的有限动作目录 |

## 3. 一个 Plugin 多个 Function

```ts
export const supportPlugin = definePlugin({
  manifest: supportManifest,
  functions: [knowledgeQuery, ticketCreate, ticketProgress]
});
```

安装时会拒绝同一 Plugin 内重复的 `functionId`，也会拒绝 Function capability 超出 Plugin capability 上界的情况。不同 Plugin 可以提供同一个 Function，例如两个 `knowledge.query` provider；Function 阶段看到一个有界能力，Plugin 阶段再选择具体 provider。

## 4. Operation 和确认策略

Operation 是 Function 内的动作目录：

```ts
[
  { name: 'search', kind: 'read', description: '检索知识库' },
  { name: 'create', kind: 'action', description: '创建工单' }
]
```

`read` 表示只读能力；`action` 表示可能产生副作用，必须进入既有 Policy/confirmation 流程。Operation 名称不能重复，目录只用于当前 Function 的候选解释、策略判断和执行边界。

## 5. 固定响应信封和回复模型

Handler 的输出必须携带固定的 `FunctionResponse` 信封：

```ts
type FunctionResponse =
  | { schemaVersion: 'iar.function-response/v1'; mode: 'model'; ui?: JsonValue }
  | { schemaVersion: 'iar.function-response/v1'; mode: 'direct'; text: string; ui?: JsonValue }
  | { schemaVersion: 'iar.function-response/v1'; mode: 'none'; ui?: JsonValue };
```

响应模式的边界由运行时按已选中的 Operation 决定，而不是由 Handler 自己声明：

- `read`/query 结果必须使用 `mode: 'model'`，运行时会把经过输入/输出 Schema 校验的结构化结果交给 Response Model 汇总后再回复用户；自我介绍也走这条路径。
- `action` 结果可以使用 `model`、`direct` 或 `none`。确认、表单和纯 UI 状态通常使用 `none`；完整且有界的固定回执才使用 `direct`。
- 查询 Function 返回 `direct` 或 `none` 会在执行边界 fail-closed，不会进入 Workflow 或聊天回复。

Response Model 的提示词按三层组合：Runtime 固定安全与 Markdown/JSON 输出协议、创建 Agent 时的 `systemPrompt` 总体提示词、当前 Function/Plugin 的 `supplementaryPrompt` 附加提示词。用户只能通过 Agent 配置或受控 Plugin 配置输入后两层，不能覆盖 Runtime 安全规则。

如果用户追问刚刚已经确认的结果，运行时只把 `factHistory` 中带来源的可信事实交给 Response Model，不重新执行 Function，也不会把模型生成的自然语言写回事实链；唯一回答标记为 `context_answered`，事实不足或有歧义仍标记为 `clarification`。

## 6. 意图识别和动态路由

意图识别输出的 `intent` 使用 Function ID，例如 `ticket.create`。模型只能从当前路由请求提供的有限候选中选择，不能发明 Function 或 Plugin。

动态路由仍遵守以下约束：

- 连续无法解析达到阈值后，只生成当前 enabled 且授权的候选。
- Function 候选由 PluginHost 当前包派生，系统 Plugin 和 disabled Plugin 不进入候选。
- Plugin 选择后，Host 会重新验证 Plugin 状态、Function ownership、capability 和 policy。
- 候选在等待确认期间失效时拒绝执行，不自动切换到其他 Plugin。
- 普通入口、流式入口、会话恢复和 Pi Bridge 共用同一个会话状态机。

## 7. 新增 Function 检查清单

- [ ] 在已有业务 Plugin 包中用 `defineFunction` 定义 Function。
- [ ] `functionId`、动作类型、输入输出 Schema 和 Operation 目录完整且稳定。
- [ ] Function capability 是 Plugin capability 的子集。
- [ ] 所有有副作用的 Operation 都标记为 `action`。
- [ ] Handler 只接收 JSON 输入和只读执行上下文。
- [ ] 将 Function 放入 Plugin 的 `functions` 数组，再通过 `createIarRuntime` 注册。
- [ ] 为正常路由、动态候选、确认、恢复和 Handler ownership 增加测试。
- [ ] 确认模型输入中只出现当前有限候选，不把注册表或原始消息直接交给模型。
- [ ] 查询/读取 Operation 返回 `mode: 'model'`，确认或表单等动作明确选择 `direct` 或 `none`。

不要再维护 `functionIds` 宿主白名单，也不要把 `functionId` 写回 Plugin Manifest 顶层；Function 的存在和归属由 Plugin 包本身定义。
