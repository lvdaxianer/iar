# Design

## Context

`BehaviorContext` 已经保存成功动作产生的 `verified` facts，并且 semantic、decision、fallback、response 模型都会收到当前结构化上下文。当前路由把语义意图直接映射到 Function，Function 的默认操作又可能是副作用；因此“我是第几个”这类查询可能因为历史业务词再次进入原动作。目标是让模型决定操作类型和有限候选，程序只保留通用边界。

## Goals / Non-Goals

**Goals:**

- 将语义意图与固定 `actionType` 分离，要求模型显式判断查询、动作或未知。
- 先按会话 scope、Plugin 状态、权限和 action type 形成有限候选，再由模型选择 Plugin/Function。
- 没有匹配候选时由回答模型基于当前问题和 BehaviorContext 直接回答或反问。
- 普通与流式入口共用相同决策和终止路径。
- 所有模型选择都经过候选集合、Schema、权限、策略和副作用边界校验。

**Non-Goals:**

- 不改变 `BehaviorContext`、持久化 Provider 的存储模型或公开 `DecisionResult` 结果形状。
- 不为工单、人工服务、排名等业务编写关键词分支。
- 不让回答模型选择或执行 Function；回答模型只能回答事实或提出澄清。

## Decisions

### 1. 先由语义模型判断固定动作类型

语义模型接收当前用户问题和 BehaviorContext，输出固定 action type：`query`、`create`、`update`、`delete`、`transfer`、`execute` 或 `unknown`。`intent` 只描述可能的能力领域，不能单独授权副作用。查询类问题必须优先标为 `query`；无法判断时标为 `unknown` 并进入澄清候选。

这避免把“出现了历史业务名词”直接等同于“再次执行原动作”。动作类型属于通用协议，不包含任何业务名称。

### 2. 候选准备只做静态硬过滤

运行时按 routing scope、Plugin 生命周期、授权、Function/Plugin 归属和 action type 交集生成有界候选。模型只看到候选的稳定标识、描述、支持动作、风险和所需槽位；模型不能新增候选、能力或权限。

Plugin 选择和 Plugin 内 Function/Action 选择都使用现有统一 `DecisionResult` 形状。JEV 与 Intent Model 仍遵循既有优先级和验证边界。

### 3. 无匹配 Function 时由回答模型决定直接回答或反问

无匹配、低置信度、候选不兼容、模型拒绝选择或语义为 `unknown` 时，调用现有回答模型。回答模型接收当前问题、BehaviorContext、有限的路由证据和失败原因，并遵循：有 verified fact 就回答，没有明确事实就澄清，不能编造、不能选择 Function、不能执行副作用。

回答模型返回现有 `iar.response/v1`，可附带受约束的 clarification metadata；该 metadata 只更新 pending，不授予执行权限。

### 4. 执行前保留通用 fail-closed 校验

即使模型返回了选择，运行时仍检查 choice 是否在当前候选集、action type 是否兼容、Function 是否归属当前 Plugin、权限和策略是否通过。任何不兼容都转入回答/澄清，不进入 Action 创建。该校验不分析业务词，只验证结构和安全边界。

### 5. 普通与流式入口共享编排语义

普通和流式入口共享语义抽取、候选准备、模型决策和 fallback 的判定。差异只存在于 response 的传输形式；两条路径必须对同一输入产生相同的是否执行结论。

## Risks / Trade-offs

- [Risk] 模型把查询误选成动作 → 语义输出要求固定 action type；候选按 action type 过滤，执行前再次校验，不兼容时 fail-closed 并转回答模型。
- [Risk] Plugin 数量增长导致候选过多 → routing scope、生命周期、权限和 action type 先做有界过滤，模型只接收有限候选，超出上限时进入澄清而不是扩大授权范围。
- [Risk] 回答模型无法从 facts 找到用户要求的字段 → 提示词要求只引用 verified facts，不足时澄清；运行时不伪造答案。
- [Risk] 回答模型无法区分直接回答和需要澄清 → 统一使用结构化 response 协议，并把 verified facts、pending 和失败原因作为明确输入。

## Migration Plan

1. 扩展语义模型的固定 action type 约束和模型输入提示词。
2. 接入候选 action type 过滤和无匹配 fallback。
3. 增加查询、事实回答、反问、新动作、普通/流式的回归测试。
4. 观察候选数量、决策结果和 fallback 原因码；确认没有副作用绕过候选和策略边界。
5. 如果需要回滚，恢复旧的 Function-first 选择逻辑；BehaviorContext、事件格式和持久化 Provider 无需迁移。
