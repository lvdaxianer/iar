# 消息耗时与 traceId 展示设计

## 目标

在每条机器人回复底部显示本轮总耗时和短 traceId；在右侧 Timing 面板显示完整 traceId 与阶段耗时。两处均消费服务端同一份 timing summary，不由前端重复计时。

## 展示

```text
已执行 · iar.self-introduction · Response Model · 耗时 5.55s · trace 2b4f4bd0…e3db9b
```

短 traceId 通过原生 `title` 提供完整值；Timing 面板直接显示完整值并允许换行。没有 timing 或字段缺失时，保持旧 meta，不显示伪造值。

## 调用链

```text
IAR turn -> SSE timing -> Timing 面板
                    -> 当前消息的 meta
```

Pi host 保存当前轮 pending timing，entry/流式回复完成时消费，并在完成后清理；下一轮不会继承上一轮 trace。

## 验证

- 页面装配测试验证字段和片段契约。
- Pi host 会话测试验证 timing 与 entry 的关联、清理和缺失降级。
- 运行 focused tests 与完整 `npm test`。
