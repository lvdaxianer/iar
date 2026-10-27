# 性能优化状态对齐（2026-10-26）

本文对照 [`2026-10-22-real-model-baseline.md`](./2026-10-22-real-model-baseline.md) 的四条后续建议，核对 master 现状并给出下一步入口。结论以源码为准。

## 逐条核对

| 基线建议 | master 状态 | 证据 |
| --- | --- | --- |
| 精简 `semantic.extract` 输入和系统提示词 | 输入侧已做，提示词侧待真实模型 A/B | 用户输入已按上下文预算组装（`buildSemanticUserPromptWithBudget`，见 `examples/agent-sandbox/src/models/model-input-transport.ts:117`）；系统提示词仍保留 20 条路由安全规则，剪枝必须过真实模型回归 |
| 关闭结构抽取的 thinking | 已实现 | `llm-provider.ts:161`（semantic.extract）、`:164`（context.compact）及嵌套路由（`:424,438,449`）均传 `thinking: { type: 'disabled' }` |
| 限制结构化输出长度 | 暂不建议改动 | 全局 `MAX_MODEL_OUTPUT_TOKENS = 4096`（`model-transport.ts:36`）；语义帧虽小，但降低上限对常规延迟无收益，只影响病态生成，截断风险大于收益 |
| 明确的内置 Plugin 意图快速路径 | 未实现，需要先定范围 | 该路径会绕过 `semantic.extract`，与"每轮都带实时结构化上下文走语义模型"的现行架构冲突；必须先定义哪些意图可走快速路径，并用 50 场景真实模型评测做验收门 |

## 下一步

1. **重新基线**：按 2026-10-22 文档的计时格式，在同一入口跑 10 样本，确认关闭 thinking 之后 `semantic.extract` 的 P50/P95 是否已回落；这是其他优化的前提。
2. **提示词剪枝**：只有在重新基线仍显示抽取延迟占主导时才进行；每次剪枝都跑 `scripts/run-real-pi-50-scenarios.mjs` 对应的 50 场景语义评测，任何场景回退即回滚。
3. **快速路径**：若要做，单独立 OpenSpec change：明确候选意图集合（建议先从"自我介绍插件"这类无槽位、无副作用的 query 开始）、保持会话范围/插件状态/权限过滤不变、关闭时零行为变化（默认关），验收门同上。

## 入口命令

```bash
# 本地真实模型基线（需要配置 .env 中的 IAR_LLM_* 变量并启动沙箱）
npm run demo:sandbox

# 50 场景语义回归（对 8878 服务端到端，退出码非零即失败）
node scripts/run-real-pi-50-scenarios.mjs
```
