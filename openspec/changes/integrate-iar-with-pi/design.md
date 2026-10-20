# Design

## Context

IAR 已有可串行化的 SandboxSessionManager、行为上下文、Workflow、PluginHost、确认校验和持久化恢复能力。Pi 已提供 `input` 扩展钩子、会话生命周期钩子、命令注册和 Package 元数据加载能力；Pi 核心不应为了接入 IAR 而修改。

本设计遵循 `pi-bridge` spec：Pi 的会话负责用户可见的编码对话，IAR 的会话负责已验证事实、路由、动作、工作流和确认；桥接层只保存二者的关联，不复制另一方的权威状态。

## Goals / Non-Goals

**Goals:**

- 提供可通过 `pi install` 和 SDK `extensionFactories` 启用的 `@iar/pi-bridge`。
- 提供版本化、有界的 IAR Bridge HTTP API。
- 复用现有会话队列和执行边界，支持业务输入、澄清、待确认、确认和取消。
- 在明确无业务路由时让 Pi 继续原有 Agent 流程；桥接故障默认阻断输入。

**Non-Goals:**

- 不修改 Pi 仓库、Pi Agent 核心或 Pi 原生会话存储。
- 不把 IAR 变成 Pi 的模型 Provider、Tool 或第二套 Agent。
- 不在本变更中实现跨机器账号认证、租户网关或新的数据库 Provider。

## Decisions

### 1. 外置 HTTP Bridge

`@iar/pi-bridge` 只依赖 Web Fetch 和 Pi 扩展的结构化最小接口；IAR 服务注册 `/api/bridge/v1`。Pi 核心保持原样，CLI 用户可安装包，SDK 用户可直接导入工厂。

### 2. 复用现有 SandboxSession

桥接请求使用现有 `SandboxSessionManager` 的串行队列和同一会话实例。新增 `bridgeTurn` 仅在路由为 `noul` 且没有待处理 IAR 上下文时返回 `pass_through`；其它结果继续使用已有执行、澄清和确认状态。

### 3. 分离会话权威

Pi 扩展使用 Pi session ID 打开 bridge 会话，IAR 返回自己的 session ID。请求正文不携带行为上下文、Action 或确认范围，确认只接受当前 IAR 会话的 actionId。映射目录先按 IAR 进程生命周期保存，已知 IAR ID 仍可通过既有 Provider/快照恢复。

### 4. disposition 驱动 input

扩展忽略 `source=extension`，防止展示消息递归进入桥接。`pass_through` 返回 Pi `continue`；其它 disposition 使用 custom message 展示 IAR 回复并返回 `handled`。IAR 不可用时也返回 `handled`，避免业务文本落入 Pi 的 shell/tool 路径。确认与取消通过 `/iar-confirm`、`/iar-cancel` 命令直接调用 IAR。

### 5. Pi 依赖可选

包不把 Pi 包作为运行时依赖，而是导出结构化最小扩展类型和默认入口；Pi Package metadata 声明 `pi.extensions`，构建产物同时提供公共入口和 Pi 专用入口。

### 6. 有界 HTTP 与安全日志

Bridge 路由复用 Sandbox 请求审计和会话预约；session key、消息、action input 和异常正文不写入日志。客户端配置请求超时，响应按版本、disposition、session ID 和稳定 reason code 校验；不认可的响应视为桥接故障并 fail-closed。

## Risks / Trade-offs

- [IAR 进程重启后内存映射丢失] → API 接受显式 IAR session ID 恢复路径；后续可把映射目录接入 Provider。
- [Pi custom message 进入 Pi 上下文] → 只承载公开 reply 和 disposition，不承载事实、Action input、token 或完整事件；IAR 仍是业务状态权威。
- [桥接不可用时普通 Pi 输入被阻断] → 默认安全优先，并提供显式配置切换为 `continue` 的能力，默认保持 fail-closed。

## Migration Plan

1. 发布 IAR Bridge 路由和 `@iar/pi-bridge`，不改变既有 `/api` 路径。
2. 启动 IAR 服务，再通过 Pi Package 或 SDK 加载扩展；扩展启动时创建/恢复映射。
3. 观察 disposition、超时和失败指标；普通 Pi 输入仍由 Pi 自己处理。
4. 回滚时卸载 Pi 包或移除 `extensionFactories`，IAR Bridge 路由保持兼容。

## Open Questions

- 生产环境的 Pi→IAR 映射是否进入独立租户隔离存储，属于后续部署与 Provider 选择，不改变本次协议。
