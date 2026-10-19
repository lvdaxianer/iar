# Proposal

## Why

当一次动作已经成功并把结果写入结构化上下文后，用户可能只用几个字追问结果，例如“我排第几个”“单号是多少”。当前路由把业务意图、Function 和动作类型耦合在一起，模型容易把历史业务词误判成新的副作用操作。需要把“查询/新动作/无法判断”作为通用决策维度，由模型在有限候选中判断；没有合适 Function 时，再由回答模型依据结构化上下文决定直接回答还是反问。

## What Changes

- 将固定 `actionType` 与语义意图分离，由语义模型判断当前输入是查询、创建、更新、删除、转接、执行或未知。
- 先使用会话 routing scope、Plugin 生命周期、权限和 action type 做候选硬过滤，再由模型从有限 Plugin/Function 候选中选择，不按业务关键词写程序分支。
- 没有合适的 Plugin/Function 候选时，直接进入回答模型；回答模型依据结构化上下文决定直接回答还是提出澄清，不为了凑出路由而选择业务动作。
- 没有合适 Function、模型拒绝选择或候选置信度不足时，调用回答模型，由它依据当前问题和 BehaviorContext 决定直接回答或提出澄清问题。
- 普通与流式会话入口共享同一候选、决策和 fallback 语义。
- 明确的新副作用动作继续经过原有 Function、Plugin、权限、策略和确认链路。
- 增加跨业务回归测试与技术方案文档。

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `structured-model-context`: 模型必须结合结构化上下文判断查询、动作、直接回答或反问；无匹配 Function 时不得隐式执行副作用。

## Impact

- 影响 `examples/agent-sandbox` 的语义抽取、Plugin/Function 路由、fallback/response 和普通/流式会话编排。
- 不改变公开 `DecisionResult`、`BehaviorContext`、Function/Plugin Manifest 或持久化 Provider 接口。
- 不增加业务专用的 Function 判断；程序只负责静态候选边界、模型输出校验、权限/策略和执行安全。
