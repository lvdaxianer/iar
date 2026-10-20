# IAR ↔ Pi Bridge 设计

## Context

IAR 已有可串行化的 SandboxSessionManager、行为上下文、Workflow、PluginHost、确认校验和持久化恢复能力。Pi 已提供 `input` 扩展钩子、会话生命周期钩子、命令注册和 Package 元数据加载能力；Pi 核心不应为了接入 IAR 而修改。

本次设计以 OpenSpec 的 `pi-bridge` 能力为行为约束。Pi 的会话负责用户可见的编码对话，IAR 的会话负责已验证事实、路由、动作、工作流和确认；桥接层只保存二者的关联，不复制另一方的权威状态。

## Goals / Non-Goals

**Goals:**

- 提供可通过 `pi install` 和 SDK `extensionFactories` 启用的 `@iar/pi-bridge`。
- 提供版本化、可验证、有界的 IAR Bridge HTTP API。
- 复用现有 IAR 会话队列和执行边界，支持业务输入、澄清、待确认、确认和取消。
- 在明确无业务路由时让 Pi 继续原有 Agent 流程；桥接故障默认阻断输入。
- 用测试证明会话隔离、重复确认、上游故障和扩展递归保护。

**Non-Goals:**

- 不修改 Pi 仓库、Pi Agent 核心或 Pi 原生会话存储。
- 不把 IAR 变成 Pi 的模型 Provider、Tool 或第二套 Agent。
- 不在本变更中实现跨机器的账号认证、租户网关或新的数据库 Provider。
- 不让 IAR 处理没有业务路由的普通编程问题。

## Decisions

### 1. 采用外置 HTTP Bridge，而不是改 Pi 核心

`@iar/pi-bridge` 只依赖 Web Fetch 和 Pi 扩展的结构化最小接口；IAR 服务器注册 `/api/bridge/v1` 路由。这样 Pi 核心保持原样，CLI 用户可安装包，SDK 用户可直接导入工厂。相比 fork Pi 或把 IAR 代码注入 Pi Agent，HTTP 边界更容易独立发布、超时、审计和回滚。

### 2. 在现有 SandboxSession 上增加 bridge turn 入口

桥接请求使用现有 `SandboxSessionManager` 的串行队列和同一会话实例。仅新增 `bridgeTurn` 的返回语义：路由为 `noul` 且没有待处理 IAR 上下文时返回 `pass_through`；其余 IAR 结果继续使用已有执行、澄清和确认状态。这样不会创建第二套会话、Workflow 或 PluginHost。

### 3. 用 Pi session key 做映射，IAR session ID 做权威资源标识

Pi 扩展在 `session_start` 取得 Pi session ID，调用 bridge open；IAR 端保存受限的 `piSessionId → iarSessionId` 映射并返回 IAR ID。请求正文不携带行为上下文、Action 或确认范围，确认只接受当前 IAR 会话的 actionId。当前 MVP 的映射目录随 IAR 进程生命周期存在，IAR 自身持久化仍负责已知 IAR ID 的恢复；生产部署可在后续替换为持久化目录而不改变协议。

### 4. 用 disposition 驱动 Pi `input` 结果

扩展忽略 `source=extension`，避免 `sendMessage` 等展示行为再次触发桥接。`pass_through` 返回 Pi `continue`；其它 disposition 使用 custom message 展示 IAR 回复并返回 `handled`。IAR 不可用时也返回 `handled`，避免业务文本落入 Pi 的 shell/tool 路径。确认与取消通过 `/iar-confirm`、`/iar-cancel` 命令和明确的中文快捷输入直接调用 IAR。

### 5. Bridge client 保持 Pi 依赖可选

包不把 Pi 包作为运行时依赖，而是导出结构化最小 `PiExtensionAPI` 类型和默认扩展入口；这避免不同 Pi 版本的类型/安装耦合，运行时仍由 Pi 注入实际 API。包 metadata 声明 `pi.extensions`，构建产物同时提供公共入口和 Pi 专用入口。

### 6. HTTP 边界采用有界输入、固定错误和链路日志

Bridge 路由复用 Sandbox 的请求审计和会话预约；session key、消息、action input 和异常正文不写入日志。客户端配置请求超时，响应按版本、disposition、session ID 和稳定 reason code 校验；不认可的响应视为桥接故障并 fail-closed。

## Risks / Trade-offs

- [IAR 进程重启后内存映射丢失] → Bridge API 接受显式 `iarSessionId` 恢复路径；IAR 已有 Provider/快照恢复能力，后续可把映射目录接入同一 Provider。
- [Pi custom message 进入 Pi 会话上下文] → custom message 只承载 IAR 的公开 reply 和 disposition，不承载事实、Action input、token 或完整事件；IAR 仍是业务状态权威。
- [Bridge 不可用时普通 Pi 输入被阻断] → 默认安全优先并提供配置项切换为显式 `continue`，由部署方自行承担降级风险；默认值保持 fail-closed。
- [Pi 扩展 API 未来变化] → 只使用 `input`、生命周期、命令、`sendMessage`、`appendEntry`/UI 的最小能力，并通过结构化适配类型和集成测试锁定兼容面。

## Migration Plan

1. 发布 IAR Bridge 路由和 `@iar/pi-bridge`，不改变现有 `/api` 兼容路径。
2. 先启动 IAR 服务，再通过 Pi Package 或 SDK 加载扩展；扩展启动时创建/恢复映射。
3. 观察 bridge disposition、超时和失败指标；普通 Pi 输入仍由 Pi 自己处理。
4. 回滚时卸载 Pi 包或移除 `extensionFactories`，IAR Bridge 路由可保持兼容，不影响既有 Sandbox API。

## Open Questions

- 生产环境的 `piSessionId → iarSessionId` 映射是否应进入独立的租户隔离存储，属于部署和持久化 Provider 选择，不改变本次协议。
