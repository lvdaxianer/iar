# Proposal

## Why

IAR 已具备意图路由、授权、动作执行和会话恢复能力，但 Pi 目前只能把用户输入交给自己的 Agent 流程，无法在不修改 Pi 核心的情况下复用 IAR 的业务决策。现在需要一个稳定的外部桥接边界，让 Pi 用户可以通过标准 Package/SDK 方式启用 IAR，同时保持 Pi 的聊天会话与 IAR 的行为会话职责分离。

## What Changes

- 新增 `pi-bridge` 能力，定义 IAR 面向 Pi 的会话、输入、确认、取消和状态接口。
- 新增 `@iar/pi-bridge` 可发布包，提供 Pi Extension Factory 和 IAR HTTP Client。
- 为每个 Pi 会话维护稳定的 `piSessionId` 与 `iarSessionId` 映射，并支持恢复已有 IAR 会话。
- 在 Pi 的 `input` 扩展钩子中调用 IAR：业务输入由 IAR 处理，普通编程输入继续交给 Pi Agent。
- 明确 `pass_through`、`handled`、`clarification`、`awaiting_confirmation` 四类桥接结果，避免 IAR 与 Pi 重复生成回复。
- 将确认/取消作为 IAR 的显式操作转发，并在 IAR 不可用时默认 fail-closed，避免业务请求意外降级为 Pi 工具调用。
- 补充协议、插件安装、SDK 加载、会话隔离、重复请求和上游不可用场景的测试与文档。

## Capabilities

### New Capabilities

- `pi-bridge`: 提供 Pi 扩展与 IAR 行为运行时之间的输入路由、会话映射、确认转发和结果处置契约。

### Modified Capabilities

<!-- 现有能力的需求不直接改变；新桥接行为由 pi-bridge 独立承载。 -->

## Impact

- IAR：新增桥接协议类型、HTTP 路由/适配层、Pi Package 源码与测试。
- 发布边界：新增 `@iar/pi-bridge` workspace package，必须提供独立构建产物、类型声明和 npm 公共入口。
- Pi：仅使用现有扩展 API，不修改 Pi 源码或核心会话实现。
- 运行时：Pi 聊天会话继续由 Pi 管理，IAR 行为状态、确认状态和业务事件继续由 IAR 管理。
