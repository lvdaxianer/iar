# Design

## Context

现有 Runtime 已有 PluginHost、FunctionDefinition、`semantic.extract`、JEV/Intent Model DecisionAdapter 和 `response.generate`，但路由候选仍以 Function 为中心：语义模型接收每个 Function 的描述，`PluginFirstRouter` 再调用 `plugin.select` 和 `function.select`。这与 Plugin 包拥有多个 Function 的注册模型不一致，也会让一次用户输入产生过多模型调用。

目标路径为：

```text
当前输入/上下文
  -> semantic.extract（DeepSeek：语义 + Plugin 提案）
  -> 程序过滤并重验证 Plugin
  -> function.call（JEV；无 JEV 时 Intent Model：Function + Operation + 参数）
  -> 程序校验参数/权限/确认并执行
  -> response.generate（DeepSeek：根据真实结果汇总）
```

正常查询最多 3 次模型调用；没有可用 Plugin 时只走语义模型和兜底回复；`direct`/`none` 的动作结果不调用回复模型。

## Goals / Non-Goals

**Goals:**

- 保持 Plugin > Function 的所有权边界：第一阶段只选择 Plugin，第二阶段只能选择已选 Plugin 内的 Function。
- 让 `function.call` 返回明确的 Function 名称、Operation 和 JSON 参数；任何模型输出都不能直接触发外部副作用。
- 固定模型分工：`semantic.extract` 和 `response.generate` 使用普通模型 profile（示例配置为 `deepseek-v4-pro`）；`function.call` 使用 JEV，JEV 缺失时使用 Intent Model。
- 在 OpenAI-compatible 请求中支持受控 `tools`/`tool_choice`；不支持原生 tools 的 fallback 仍使用同一版本化 JSON 提议契约。
- 继续执行 PluginHost 当前状态、ownership、授权、能力、Function inputSchema、Operation、Policy 和 confirmation 校验。
- 保留现有旧 DecisionAdapter，允许旧测试和旧接入在新契约迁移期间继续运行。

**Non-Goals:**

- 不让模型决定权限、能力、是否确认或是否执行。
- 不把 Plugin 级描述扩展为 Function 级全量描述，也不把所有 Function Schema 放进第一阶段 prompt。
- 不改变 Function response `model/direct/none` 语义、查询结果交给 Response Model 的规则和现有 Pi 兜底边界。
- 不在本次变更中引入独立的工具编排服务或外部 Agent 框架。

## Decisions

### 第一阶段：语义和 Plugin proposal

`semantic.extract` 的输出在保持 `iar.semantic-frame` 字段兼容的基础上增加可选 `pluginId`。输入改为当前 Agent 启用且授权的 Plugin 级描述，每个 Plugin 只出现一次，带有聚合后的 actionTypes；Function 描述只保留在运行时，不进入第一阶段模型上下文。`pluginId` 是不可信提案，运行时必须按 action、生命周期、Agent 禁用集、租户授权和规则重新过滤。

若模型未给出合法 Plugin 或没有候选，运行时不猜测 Function，交由 Response Model 从已验证事实回答或澄清。旧调用方未返回 `pluginId` 时保留兼容的旧 Plugin decision fallback，但 Agent sandbox 的新主路径使用 proposal。

### 第二阶段：Function Calling

运行时根据已选 Plugin 从 PluginHost 读取当前 Function 快照，构造有界工具集合：`name=functionId`，描述包含 Function description、固定 actionTypes 和 Operation 元数据，参数 Schema 使用已安装并校验过的 Function inputSchema。模型只能返回一个工具调用提议。

`function.call` 的公共输出统一为 `iar.function-call/v1`：`pluginId`、`functionId`、`operation`、`arguments`、`confidence`。原生 OpenAI tool call 和 Intent Model 的 JSON fallback 都在 adapter 边界归一化为该结构；不存在工具调用、工具名不在候选集、参数不是 JSON 对象或置信度不足时返回稳定澄清/拒绝。

### 程序执行门禁

运行时按以下顺序处理第二阶段结果：

1. 重新读取并验证 Plugin 仍为 enabled business Plugin。
2. 验证 `functionId` 确实属于该 Plugin，不能使用模型新增的 Function。
3. 验证 Operation 存在且与 Function 的 Operation kind/action 相容。
4. 使用启动时编译的 inputSchema 校验 `arguments`，拒绝未知字段、缺失字段和越权字段。
5. 重新执行授权、能力、Policy、confirmation 和 idempotency 门禁。
6. 只有全部通过后才创建 Action 并调用 Handler。

### 模型和 fallback

`semantic.extract`、`response.generate` 使用普通模型 provider，配置默认模型为 `deepseek-v4-pro`，结构化抽取关闭 thinking 并使用有界 token。`function.call` 的 profile 按 `DecisionBackendResolver` 解析：有效 JEV primary 优先；没有 JEV profile 才解析 Intent Model。provider unavailable/timeout 按既有 profile fallback 规则处理，不能把未配置 JEV误报成验证失败，也不能静默退回 mock。

### 兼容和迁移

旧 `function.select`、`plugin.select` 和 `iar.decision/v1` 保留在公共包中，旧路由器测试继续可用。新 `PluginFirstRouter` 在存在 `semantic.pluginId` 时走 proposal + function.call；没有 proposal 或没有 function-call adapter 时走当前兼容路径，迁移完成前不改变旧 SDK 的公开类型。

## Risks / Trade-offs

- Plugin 级描述可能比 Function 描述更粗 → 用聚合 actionTypes 和 Plugin description 提供第一阶段范围，第二阶段只发送已选 Plugin 的精确 Function Schema。
- JEV 可能不支持原生 tools → provider 同时支持结构化 JSON fallback，adapter 对外只暴露同一 `function-call/v1`。
- 模型输出的参数可能不完整 → Schema 校验返回 bounded clarification，不创建 Action。
- Plugin 在两个模型调用之间被禁用或升级 → 第二阶段和执行前都重新读取 PluginHost 并拒绝 stale ownership。
- 新 role 增加配置复杂度 → 示例配置集中声明三个业务阶段，旧 selection profile 保留兼容但不在新主路径使用。

## Migration Plan

1. 先增加 `function.call` 类型、Schema、模型 role 和传输工具边界，写 focused RED tests。
2. 增加 PluginHost 的 Plugin 级描述和 Function 工具描述，改造 semantic prompt/输出以携带 Plugin proposal。
3. 改造 `PluginFirstRouter` 和 sandbox session：proposal 后加载当前 Plugin Functions，通过 function.call 生成参数，再进入现有 Action/response 流程。
4. 更新模型配置、README 和离线 scripted provider；补充禁用 Plugin、ownership、invalid arguments、JEV fallback 和 query response 测试。
5. 运行 focused tests、完整 `npm test`、OpenSpec strict validation、代码审查和最终集成审计。

## Open Questions

- 生产 JEV 是否支持 OpenAI `tools` 字段由 provider capability 决定；不支持时使用同一输入中的 JSON 工具目录和结构化 fallback，不改变运行时安全门禁。
