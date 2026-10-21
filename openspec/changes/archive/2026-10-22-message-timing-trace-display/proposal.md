# Proposal

## Why

当前消息卡片只能看到处理结果和来源，用户无法在阅读答案的同时判断一次请求花了多久，也无法把页面上的某条回复与日志中的 traceId 快速对应起来。服务端已经通过 `timing` 事件提供了这些信息，现在需要把同一份观测数据呈现在消息卡片和详情面板中。

## What Changes

- 在 Sandbox 和 Pi host 的机器人消息底部展示本轮总耗时。
- 在消息底部展示短 traceId，并通过悬停提示保留完整 traceId；右侧 Timing 面板展示完整 traceId。
- 继续使用服务端下发的 timing summary，不在浏览器重复计时或推断阶段耗时。
- 保留现有阶段耗时列表，并补充无 timing、异常或缺失 traceId 时的安全降级显示。
- 不新增日志依赖、不展示提示词、模型响应原文或其他敏感字段。

## Capabilities

### New Capabilities

### Modified Capabilities

- `response-observability`: 将已有轮次观测数据扩展到消息卡片和 Timing 面板的用户可见展示契约。

## Impact

- 修改 Sandbox 与 Pi host 的静态页面片段、页面模板中的 Timing 字段及相关页面回归测试。
- 不修改 bridge/API 数据结构，不修改服务端计时与结构化日志格式。
- 不新增运行时依赖；traceId 只通过 `textContent` 和 DOM `title` 写入页面，避免 HTML 注入。
