# Design

## Context

See `proposal.md` for motivation and user-facing behavior. 当前 Agent 创建配置由 `packages/runtime` 保存 `disabledPluginIds` 与 `selfIntroduction.extraPrompt`；沙箱模型提示词位于 `examples/agent-sandbox/src/models`，IAR Response Model 和 Pi Agent 之间没有共享的 Agent 级表达配置。Function 回复契约已经区分 `model`、`direct` 和 `none`，自我介绍 Function 已使用 `model`。

本次变更跨越 Runtime 配置、沙箱模型输入、Pi 委托和 bridge 可观测结果，但不改变 Function 输入输出 Schema、路由授权或确认边界。

## Goals / Non-Goals

**Goals:**

- 在 Agent 创建时接受并保存有界的 `systemPrompt`。
- 让 IAR Response Model 和 Pi Agent共享该总体提示词。
- 保留固定 Runtime 安全规则和角色输出协议的最高优先级。
- 让自我介绍始终通过 Response Model 汇总，支持 Markdown 写入 `text` 字段。
- 在 bridge 结果和页面调试信息中区分回复来源。
- 为配置、提示词组合、model/direct/none 边界和实际模型调用补充测试。

**Non-Goals:**

- 不允许总体提示词改变路由候选、启用或授权 Plugin。
- 不让总体提示词覆盖 Semantic Extractor、Intent Decision 或 Context Compactor 的结构化协议。
- 不新增独立配置页面；配置入口仍是 New IAR Agent 的创建参数。
- 不让 self-introduction Function 自己拼接用户可见文案。
- 不新增模型供应商、网络协议或持久化依赖。

## Decisions

### 1. Agent 总体提示词放在 Runtime 创建配置

在 `IarRuntimeOptions` 增加 `systemPrompt?: string`，并在 `IarRuntimeConfiguration` 中保存冻结后的值。这样配置与 `disabledPluginIds`、`selfIntroduction` 拥有相同的 Agent 生命周期，重置会话不会丢失配置，也不需要独立页面。

备选方案是仅在 sandbox 中通过环境变量配置；该方案无法覆盖真实 Runtime 调用方，也无法表达每个 Agent 的持久化偏好，因此不采用。

### 2. 用结构化模型输入传递总体提示词

不把用户提示词拼到固定系统提示词的字符串中，而是将它作为受限的 `agentPrompt` 字段传入回复模型输入，再由 Prompt Builder 按固定顺序组合。这样能明确区分固定协议、用户偏好和 Function 输出数据，并便于测试和限长。

组合顺序为：

```text
固定 Runtime 安全规则
→ Agent 总体提示词
→ 当前 Plugin 的 supplementary prompt
→ 角色输出协议
```

其中 Function 输出、能力描述和最近消息继续作为不可信数据放入用户内容区，不得升级为系统指令。

### 3. 只影响回复模型和 Pi Agent

`systemPrompt` 注入 `response.generate` 和 Pi Agent；语义抽取、Intent Decision、上下文压缩保持现有固定协议。表达风格要求不应该改变意图枚举、Schema 或压缩事实边界。

### 4. 自我介绍维持 `mode=model`

自我介绍 Handler 仅返回能力清单和 `extraPrompt`；`SandboxSessionReplies.directReply` 只处理 `direct` 和 `none`，`model` 继续走 `ResponseGeneratorAdapter`。在 Response Prompt 中允许 Markdown 只作用于 JSON 的 `text`，不允许模型用 Markdown 代码围栏包裹外层 JSON。

### 5. 回复来源作为受控元数据

在内部 TurnResult/bridge 映射中派生 `replySource`，而不是记录原始 Prompt 或模型输出审计文本。来源由执行路径决定：`direct` 为 `direct_function`，`model` 成功生成或失败安全回退归入 `response_model`，Pi 继续路径归入 `pi_agent`，`none` 为 `none`。页面只展示受控枚举和已有路由 ID。

## Risks / Trade-offs

- [用户总体提示词可能诱导越权] → 作为非协议配置传递，固定安全规则和候选授权始终优先；配置和输出均有边界校验。
- [Markdown 破坏 JSON 解析] → 明确 Markdown 只允许出现在 `text` 字段；增加带标题、列表和代码片段的契约测试。
- [Response Model 与 Pi Prompt 组合顺序漂移] → 集中使用 Prompt Builder，并用精确断言测试两条路径的固定片段和顺序。
- [旧调用方没有 `systemPrompt`] → 字段可选，缺省使用空 Prompt，现有配置和测试保持兼容。
- [回复来源字段与旧 bridge 客户端不兼容] → 新字段可选追加，不改变既有 `disposition`、`reply` 和 route 字段；旧客户端忽略未知字段即可。
- [日志泄露用户提示词] → 不新增原文日志；模型调用日志只保留既有安全元数据，按 logging boundary 规则验证。

## Migration Plan

1. 先扩展 Runtime 配置契约，默认 `systemPrompt` 为空，现有 Agent 行为保持不变。
2. 接入 Response Model 和 Pi Agent 的提示词组合，并调整 Markdown 规则。
3. 增加回复来源元数据和页面展示；旧 bridge 请求无需迁移。
4. 运行契约、集成、构建和启动校验；确认自我介绍默认启用、显式关闭和旧配置兼容。
5. 若模型提示词组合出现兼容问题，可将 `systemPrompt` 置空回退到原固定提示词；Function 回复模式和路由协议无需回滚。

## Open Questions

无。总体提示词的配置入口、适用模型、优先级和 Markdown 边界已经由本设计确定。
