# Design

## Goal

让用户在每条机器人回复的底部直接看到“这条回复耗时多久、对应哪条 trace”，同时保留右侧面板对完整 trace 和阶段耗时的诊断能力。

## Data flow

```text
IAR turn
  -> server timing summary { traceId, durationMs, stages }
  -> SSE timing event
      -> right Timing panel (full trace + stage list)
      -> pending timing state
  -> SSE done / Pi entry
      -> message meta formatter
      -> message footer (duration + short trace)
```

同一轮只使用服务端的 `durationMs` 和 `traceId`。浏览器不根据渲染时间重新计算总耗时，避免用户看到的数字与日志/服务端不一致。

## Presentation contract

- 有耗时：`耗时 5.55s`；小于 1 秒时使用毫秒，避免把短请求显示成 `0.00s`。
- 有 trace：`trace 2b4f4bd0…e3db9b`；消息卡片显示短值，完整值放在 `title` 与右侧 Timing 面板。
- 缺失 timing：保留原有状态/来源 meta，不显示伪造耗时或 `trace undefined`。
- Pi host 的 entry、fallback、流式回复都使用同一份 pending timing；一轮完成后清理，避免下一条消息继承上一轮 trace。

## Interaction and safety

- meta 位于消息卡片底部，与状态和来源保持同一视觉层级；不新增点击流程，不影响发送、确认、清空会话。
- 完整 trace 通过原生 tooltip 暴露，长值不撑破卡片；右侧面板使用文本节点写入并允许换行。
- 页面只渲染 traceId 和耗时这两个白名单字段，不渲染请求体、响应体、提示词或模型思考内容。
- SSE timing 丢失、超时或 malformed 时，消息仍可完成展示，右侧面板保持已有降级状态。

## Verification strategy

1. 先在 Sandbox/Pi host 页面装配测试中加入 RED 断言：页面必须包含 Timing trace 字段，消息 meta 必须消费 `durationMs` 与 `traceId`。
2. 实现格式化、meta 注入、Timing 面板更新和 Pi host pending timing 生命周期。
3. 运行对应页面装配/会话测试，再运行 `npm test`。
4. 检查方法行数、DOM 写入安全性、无 timing 降级、Pi host 跨轮次清理，并执行代码审查与最终审计。
