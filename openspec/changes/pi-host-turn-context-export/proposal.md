# Proposal

## Why

Pi Host 当前的“复制结构化上下文”只复制页面侧的路由、耗时和 pending 摘要，无法把 IAR 每轮已经生成并持续维护的结构化上下文与 Workflow 状态带出。这样无法复现话题切换、上下文恢复和确认流程问题，也无法核对真实模型每轮使用的安全状态。

## What Changes

- 扩展 Pi Bridge 状态响应，返回当前会话的安全 `structuredContext` 与 `workflowState` 投影。
- 让 Pi Host 在每轮输入、确认/取消和重连同步后接收最新状态，并在复制动作中导出当前单一会话的逐轮上下文历史。
- 继续通过白名单投影过滤 prompt、reasoning、凭据、确认 scope、原始 Action input 和其他执行授权字段。
- 保持现有路由、插件执行、确认门禁、Pi fallback 和单会话映射语义不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `pi-host-structured-context-export`: 结构化上下文复制结果增加安全的逐轮 structured context 与 workflow state。

## Impact

- 影响 `@iar/pi-bridge` 的状态协议与客户端校验，新增字段保持可选以兼容旧服务/客户端。
- 影响 Agent Sandbox Bridge state 路由、PiHostSession 状态观测和 Pi Host 网页复制快照。
- 不新增依赖，不改变业务插件、路由、Policy 或执行器。
- 需要补充协议、桥接、会话和网页快照测试，并在真实模型 `8878` 单一会话上验证。
