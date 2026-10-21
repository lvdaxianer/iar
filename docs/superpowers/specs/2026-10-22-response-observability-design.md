# 响应耗时与可观测性设计

## 背景

IAR 的模型和 Plugin 调用已经通过 SSE 输出，但目前界面缺少一轮请求的统一时间线，日志也主要是难以直接阅读的结构化 JSON。本设计只覆盖“界面显示总耗时到日志链路”的新增能力，不改变已有 Plugin/Function 路由和响应协议。

## 方案选择

候选方案有三种：

1. 只增加前端计时：改动小，但无法区分服务端阶段，也无法关联日志。
2. 只增加 Pino pretty 日志：日志更可读，但不能表达调用链和前端实时阶段。
3. 统一轮次时间线 + 双语结构化日志 + OpenTelemetry span + 独立 thinking 流：同时满足界面诊断、服务端排查和模型流展示，复杂度可分阶段控制。

选择第三种方案。现有 `iar.observability.log` 继续作为 system plugin，`safe-log` 继续负责字段白名单、脱敏和有界异步输出；Pino/pretty 与 OTel 作为输出适配层，不绕过安全边界。

## 事件和时序

一轮请求共享 `traceId`，阶段顺序为：

```text
turn.start
  -> semantic.extract
  -> route.select
  -> action.execute（仅需要业务执行时）
  -> response.reasoning（仅最终响应模型）
  -> response.first_token
  -> response.generate
  -> turn.complete
```

每个阶段至少包含开始时间、结束时间、耗时、状态和安全的阶段元数据。模型阶段额外记录模型角色、模型 ID、首 Token 时间和超时/失败分类。

## 模型流

模型 SSE 解析器同时读取 `delta.reasoning_content` 和 `delta.content`。两者分别转成 `reasoningDelta` 与 `contentDelta` 事件；如果上游不提供原生 thinking，则不伪造 thinking 事件。意图模型请求继续关闭 thinking，最终响应模型按配置开启。

原始 thinking 可以在受控 UI 区域展示，但不进入普通运行日志。运行日志只记录 reasoning 阶段的状态、耗时和首 Token 时间。

## 日志策略

机器字段保持稳定英文值，并由 pretty renderer 增加双语标签，例如 `phase=semantic.extract` 显示为“阶段 / Phase=意图抽取 / semantic.extract”。

- INFO：轮次和关键业务阶段摘要。
- WARN：慢请求、超时、fallback、桥接不可用。
- ERROR：未预期错误及安全堆栈。
- DEBUG：受控、限长、脱敏的诊断摘要，并支持现有热开机制。

所有业务记录带 `traceId`；异步回调通过 `AsyncLocalStorage` 继承上下文。完整 prompt、完整 response、API key、token 和原始 thinking 不写普通日志。

## 前端契约

Pi Host SSE 新增安全的 timing/reasoning 事件。界面显示总耗时、当前阶段、阶段明细和 thinking/answer 两个独立区域。收到首 Token 时立即更新，不等待整轮结束；超时、断流和模型不可用时保留已经发生的阶段信息并展示明确错误状态。

## 验证标准

- 一次完整请求能在界面看到总耗时和阶段耗时。
- 同一个 `traceId` 能关联服务端阶段日志和 Trace。
- reasoning 与 content 不混流，且意图模型不产生 reasoning 事件。
- 日志不泄露 prompt、response、secret 或原始 thinking。
- 慢请求、超时、断流和 fallback 都有稳定的分类。
- 日志输出失败不会阻断业务请求。
