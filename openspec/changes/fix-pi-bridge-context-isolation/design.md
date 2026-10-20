# Design

## Context

Pi 的 `sendMessage` 会把扩展自定义消息写入 Agent 会话消息，因此不满足 IAR 结果“可见但不参与后续推理”的边界要求。Pi 同时提供了不参与 LLM context 的 custom entry，以及配套的 entry renderer；IAR 当前扩展已通过结构化最小 API 对接 Pi，且不依赖 Pi runtime 包。

## Goals / Non-Goals

**Goals:**

- 保持 IAR 结果在 Pi 交互界面可见。
- 确保展示条目不进入 Pi 的模型上下文和后续 Agent turn。
- 继续保持 IAR 会话为业务状态权威，Pi 扩展只保存会话映射和待确认 actionId。
- 保持扩展包可独立编译，不引入 Pi runtime 依赖。

**Non-Goals:**

- 不修改 Pi 核心代码、会话管理器或官方 API。
- 不改变 IAR Bridge HTTP 协议、IAR 会话生命周期和确认语义。
- 不把 IAR 的完整业务历史同步到 Pi。

## Decisions

### 1. 使用 display-only custom entry

扩展注册 `iar-bridge` entry renderer，并通过 `appendEntry('iar-bridge', data)` 写入展示条目。该路径由 Pi 明确保证不参与 LLM context。

备选方案是继续使用 `sendMessage(..., { triggerTurn: false })`，但 `triggerTurn: false` 只阻止立即触发 Agent turn，不能阻止消息进入后续上下文，因此排除。另一个备选是只调用 `ui.notify`，但它无法稳定保留较长业务结果，也不适合作为 Pi 会话中的可追踪展示记录。

### 2. 保持结构化最小 API

IAR 的 `PiExtensionAPI` 增加 `appendEntry` 和 `registerEntryRenderer` 两个能力，使用本地结构类型描述 renderer 返回的 `render`/`invalidate` 组件，不导入 Pi 包。这样仍可由 Pi 的 Package/SDK 加载，并能在测试中验证“无 sendMessage 调用”。

### 3. 展示数据与业务处置分离

展示条目只携带受限后的 `content` 和 `disposition`。`pass_through` 不创建条目；`handled`、`awaiting_confirmation` 和确认/取消结果创建条目。渲染失败只影响展示，不回滚已经完成的 IAR 请求。

### 4. 非交互模式使用通知兜底

交互 TUI 模式使用 entry renderer，避免重复通知；当上下文明确不是 TUI 模式时，调用现有 `ui.notify` 作为可见性兜底。该通知仍不构造 Pi LLM message。

## Risks / Trade-offs

- [Risk] Pi 版本未提供 entry renderer 能力 → 通过 API 版本约束和安装文档明确最低能力；扩展初始化失败时沿用桥接不可用的安全降级。
- [Risk] IAR 回复包含控制字符或极长文本 → 在写入 entry 前清理控制字符并限制长度，renderer 只处理已净化数据。
- [Risk] entry renderer 的主题类型随 Pi 版本演进 → IAR 只依赖最小结构类型，renderer 使用纯文本组件，降低耦合面。

## Migration Plan

1. 先增加隔离行为规范和扩展单元/集成回归测试。
2. 将扩展展示 API 从 `sendMessage` 切换为 `appendEntry + registerEntryRenderer`。
3. 更新安装与会话边界文档。
4. 在 IAR 仓库执行类型检查、集成测试、全量测试和 OpenSpec 校验。
5. 若发现兼容问题，回滚扩展包版本即可；Pi 核心没有本次变更产生的迁移状态。
