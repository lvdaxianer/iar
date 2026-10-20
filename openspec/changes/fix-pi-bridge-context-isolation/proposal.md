# Proposal: 隔离 IAR 桥接结果与 Pi 模型上下文

## Why

当前 Pi 扩展使用 `sendMessage` 展示 IAR 结果，但 Pi 会把这类 custom message 持久化并纳入后续 LLM context。这样会破坏 IAR 与 Pi 的会话权威边界：IAR 的业务结果可能被重复发送给模型、污染后续推理，或者与 Pi 自己的上下文产生歧义。

## What Changes

- 将 IAR 结果改为 Pi 的 display-only custom entry，通过 entry renderer 在交互界面展示，但不进入 Pi 的 LLM context。
- 为展示数据增加边界控制，避免异常或过长内容直接污染终端渲染。
- 保留现有的 pass-through、handled、待确认、确认和取消行为，以及 Pi 核心零修改和无 Pi runtime 依赖约束。
- 增加回归测试和集成文档，明确 IAR 是业务会话权威，Pi 只负责输入接入和结果展示。

## Capabilities

### New Capabilities

- `pi-bridge-context-isolation`: IAR 桥接结果在 Pi 中可见但不进入 Pi 模型上下文。

## Impact

- 受影响代码：`packages/adapters/pi/src/extension.ts` 及其集成测试。
- 受影响文档：Pi 集成说明和桥接设计文档。
- 不修改 Pi 仓库，不增加 Pi 运行时依赖，不改变 IAR Bridge HTTP 协议和 IAR 会话管理语义。
