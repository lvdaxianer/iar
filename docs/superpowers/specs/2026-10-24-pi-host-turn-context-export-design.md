# Pi Host 逐轮结构化上下文导出设计

## 目标

让 Pi Host 的“复制结构化上下文”导出当前单一会话已经维护的安全 `structuredContext` 与 `workflowState`，而不是只导出路由、耗时和 pending 摘要。行为规则与 `openspec/changes/pi-host-turn-context-export/` 保持一致。

## 方案

- Bridge state 从权威 `BehaviorContext` 生成结构化上下文安全投影，从 `projectWorkflowContext` 生成 Workflow 投影。
- PiHostSession 在输入、确认/取消和重连后同步 state，通过 SSE 传递给页面。
- 页面复制快照保留最新结构化状态；其中 Runtime 已有界的 `conversationTurns` 与 `factHistory` 代表当前会话的逐轮上下文。
- 服务端、客户端和页面均使用白名单，排除 prompt、reasoning、原始消息、Action input、凭据和确认 scope。

## 非目标

不修改业务路由、Plugin、Policy、确认门禁、Action 执行或会话切换语义；不新增依赖或无界浏览器缓存。

## 验证

使用协议/桥接/页面集成测试、lint、build，并在真实模型端口 `8878` 的同一会话中验证多轮上下文复制和原有场景回归。
