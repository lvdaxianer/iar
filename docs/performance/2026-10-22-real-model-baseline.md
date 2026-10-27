# 真实模型耗时基线（2026-10-22）

## 测试范围

- 调用入口：`IarSandboxSession({ mode: "brain" }).turn()`
- 测试输入：查询当前活动告警列表
- 样本数：连续 10 次
- 统计方法：P50 取排序后第 5、6 个样本的均值；P95 使用小样本的最近秩（第 10 个样本）
- 输出限制：只记录阶段耗时和状态，不记录回复正文、思考内容、API Key 或完整 Trace ID

本次主链路使用 `deepseek-v4-pro`：

1. `semantic.extract`：DeepSeek 结构化语义抽取
2. `route.propose`：DeepSeek 嵌套 Plugin/Function 工具调用
3. `route.select`：程序侧规则、注册表、权限和 Schema 校验，不调用模型
4. `action.execute`：程序执行 Function
5. `response.generate`：DeepSeek 查询结果汇总

由于主链路使用 `route.propose`，本次查询没有额外调用 JEV 或 Intent Model；JEV 未配置时自动使用 Intent Model 的逻辑适用于兼容决策路径。

## 结果

| 阶段 | P50 | P95 | 结论 |
| --- | ---: | ---: | --- |
| `semantic.extract` | 1,994 ms | 9,674 ms | 最大波动来源，存在一次明显慢调用 |
| `route.propose` | 900 ms | 1,705 ms | 第二次模型调用，整体较稳定 |
| `route.select` | 900 ms | 1,705 ms | 程序计时包住路由返回，非第三次模型调用 |
| `action.execute` | 14 ms | 28 ms | 本地沙箱执行开销很小 |
| `response.generate` | 1,604 ms | 2,050 ms | 查询结果汇总模型调用 |
| 单轮总耗时 | 4,470 ms | 12,536 ms | 尚未达到 2.5 秒目标 |

10/10 次请求完成，未出现超时或路由失败。第 4 次 `semantic.extract` 耗时约 9.67 秒，直接把该轮总耗时拉高到约 12.54 秒。

## 结论与后续

当前慢点不是程序规则判断，也不是 Action 执行，而是模型调用，尤其是 `semantic.extract` 的尾延迟。后续优化应优先验证：

- 精简 `semantic.extract` 输入和系统提示词；
- 关闭结构抽取的 thinking，并限制结构化输出长度；
- 对明确的内置 Plugin 意图增加安全的快速路径，避免不必要的抽取模型调用；
- 保留本计时格式，继续比较优化前后的 P50/P95 和路由准确率。

> 2026-10-26 状态对齐：上述建议与 master 代码的逐条核对见 [2026-10-26-optimization-status.md](./2026-10-26-optimization-status.md)（关闭 thinking 已实现，其余需要先重新基线）。
