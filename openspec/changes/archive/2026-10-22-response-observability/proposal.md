# Proposal

## Why

当前请求只能从零散日志和界面事件推断总耗时，无法快速判断慢在意图识别、业务执行、模型思考还是最终回复。运行日志是机器可读 JSON，但缺少双语说明、统一阶段和完整 trace 关联；最终 DeepSeek 回复也无法把原生 thinking 与答案分开观察。

## What Changes

- 为每个会话轮次生成并传播统一的 trace 标识，记录总耗时、阶段耗时和模型首 Token 时间。
- 将耗时摘要和可展开的阶段明细通过 Pi Host SSE 提供给界面。
- 为最终回复模型支持原生 thinking 流，并将 thinking 与最终答案作为独立事件传输；意图识别仍不输出 thinking。
- 在现有 `iar.observability.log` 与 `safe-log` 边界上接入双语结构化日志输出，保留英文机器字段并增加中文可读标签。
- 使用 OpenTelemetry 记录阶段链路；日志、Trace、Metrics 和审计继续保持边界分离。
- 遵循日志边界：统一脱敏、限长、异步上下文透传、DEBUG 热切换，以及 INFO/WARN/ERROR/DEBUG 分层。
- 默认不把完整用户输入、完整模型答案或原始 thinking 写入运行日志；原始 thinking 只通过受控响应流展示。

## Capabilities

### New Capabilities

- `response-observability`: 为一次 IAR 会话轮次提供统一的阶段计时、首 Token 统计、Trace 关联、双语结构化日志和安全边界。
- `reasoning-stream`: 为最终响应模型提供原生 thinking 与最终答案的独立流事件，并保持意图模型无 thinking。

### Modified Capabilities

<!-- Existing capability requirements do not change; the new observability and reasoning contracts are additive. -->

## Impact

- 影响 `examples/agent-sandbox` 的会话流、模型流、Pi Host SSE 和安全日志输出。
- 影响 `packages/runtime` 的 system observability plugin 与 recorder 适配边界。
- 可能新增开发依赖 `pino-pretty`；OpenTelemetry 先通过内部 adapter 保持可选，不强制部署外部平台。
- 需要新增前端时序展示、thinking 展示和失败/超时状态测试。
