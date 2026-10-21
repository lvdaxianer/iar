# Design

## Context

现有 sandbox 已有 `StreamEvent` 阶段事件、Pi Host SSE、`safe-log` 白名单和 `iar.observability.log` recorder，但阶段事件只有粗粒度的 stage 名称，模型流只解析 `delta.content`，安全日志主要输出 JSON。实现必须保持现有 `function-response-contract` 与 `structured-model-context` 的响应、路由和隐私边界不变。

## Goals / Non-Goals

**Goals:**

- 为一轮请求建立统一的时间线，提供总耗时、阶段耗时、首 Token 和安全错误分类。
- 将阶段计时和 reasoning/answer 流通过现有 SSE 机制传到 Pi Host。
- 在现有安全日志边界之上提供双语 pretty 输出，并保留 traceId 关联边界。
- 保持日志 fail-open、异步有界、脱敏、traceId 传播和 DEBUG 热切换。
- 让最终响应模型的原生 thinking 可原样展示，同时不把它写入普通运行日志。

**Non-Goals:**

- 不改变 Plugin/Function 路由顺序、Function response mode 或输入输出 Schema。
- 不让 semantic.extract 或 context.compact 输出 reasoning。
- 不把完整 prompt、完整 answer 或 raw reasoning 作为运行日志保存。
- 本次不强制部署 Loki、Tempo、Grafana；先提供内部 Trace/日志适配边界。

## Decisions

### 统一轮次时间线

在流式会话入口创建 `TurnTiming`，使用单调时钟计算耗时，使用现有业务 traceId 做关联。`StreamEvent` 增加安全的 `timing` 和 `reasoning` 事件，旧的 `stage`、`delta`、`done` 事件保留，保证现有客户端兼容。`done` 携带总耗时和已完成阶段摘要，失败终态也携带相同摘要。

候选方案是让前端自行用 SSE 到达时间计算；该方案受网络抖动影响，无法反映服务端阶段，因此不采用。

### 模型流分离

模型传输层将 OpenAI-compatible SSE 的 `delta.reasoning_content` 与 `delta.content` 分别回调。`StreamResponseEnvelope` 仍只解析最终 answer；reasoning 只属于流式展示，不进入 response contract。上游没有 reasoning 字段时不推断、不伪造。

候选方案是把 reasoning 混入 `delta` 文本；这会破坏 Markdown、历史记录和最终答案边界，因此不采用。

### 日志适配

保留 `safe-log` 作为安全入口，新增稳定的 phase/role/outcome 枚举、双语标签和可注入的 pretty writer。外部日志或 Trace 系统后续只能通过安全 writer/traceId 边界接入，不能绕过现有白名单和有界 sink，也不把 Trace 伪装成高频日志。

候选方案是直接打印自由文本中文日志；该方案不可检索、易泄露并且无法稳定测试，因此不采用。

### UI 状态

Pi Host 新增总耗时摘要、阶段列表和 reasoning 区域。reasoning 与 answer 使用独立 DOM 容器，answer 继续沿用既有安全 Markdown 渲染；reasoning 使用纯文本渲染，不执行 HTML。流断开、超时和错误保留已经收到的计时事件，并解除输入忙碌态。

## Risks / Trade-offs

- [上游 provider 字段不统一] → 只识别 `reasoning_content` 等明确字段，缺失时不伪造，并增加 provider 兼容测试。
- [thinking 内容过大] → SSE 传输可以原样展示，但不持久化、不写普通日志，并沿用模型响应字节上限。
- [日志 sink 影响主流程] → 继续使用有界异步队列和 fail-open；pretty/Trace 输出失败只增加受控计数。
- [旧客户端不认识新事件] → 保留旧事件，新增事件可忽略；服务端仍发送原有 `delta` 和 `done`。
- [前端长请求状态不清晰] → 使用阶段状态、总耗时、错误状态和可恢复输入提示，避免页面永久 busy。

## Migration Plan

1. 先添加时间线、reasoning 事件类型和安全日志字段，保持旧事件兼容。
2. 以测试驱动改造模型 SSE 解析和会话流，再接入 Pi Host 展示。
3. 将 `safe-log` 的双语 renderer 和 Trace sink 接入现有 system logging plugin。
4. 验证 build、单元/集成测试、OpenSpec strict validation 和手工 SSE 事件顺序。
5. 回滚时移除新事件消费者和 sink 配置即可；旧的 `stage`、`delta`、`done` 仍可独立工作。

## Open Questions

- Loki、Tempo、Grafana 的部署方式不影响本次内部契约，留到实际部署环境确定后再增加 collector 配置。
