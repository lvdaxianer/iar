# Proposal

## Why

当前模型已经能够把“上一个”“第一个”等自然语言指代转换为通用关系，但运行时只有单目标解析：缺少锚点时只能失败，模型或回复层也无法保留有限候选，导致重复追问时丢失上下文。需要把关系理解、候选消歧和安全兜底拆成可恢复的运行时能力。

## What Changes

- 增加不依赖业务字段的有序事实关系候选解析：模型只输出关系、可选不透明记录锚点和有限偏移。
- 增加可持久化的待解析引用状态，保存原始指代、关系和有限不透明候选记录 ID。
- 在候选不唯一时停止路由和副作用执行，把候选作为数据交给回复模型或通用澄清流程。
- 在候选唯一时复用现有事实链解析；成功解析后累加事实来源，不覆盖已有记录。
- 保持最近原文消息与结构化上下文分离，并让普通、流式、压缩和恢复路径使用同一状态边界。
- 多次无法收敛时继续使用运行时收集的 Plugin 描述生成选择，不在核心代码写死功能名称。

## Capabilities

### New Capabilities

- `generic-reference-resolution`: 提供通用自然语言关系到有序事实候选的解析、持久化和安全消歧能力。

### Modified Capabilities

- `behavior-state`: 行为上下文需要保存可恢复的待解析引用状态。
- `structured-model-context`: 模型调用需要接收引用候选和待解析引用，并在歧义时禁止执行。

## Impact

- 影响 `@iar/contracts` 的 BehaviorContext Schema、`@iar/runtime` 的事实关系解析、Workflow 澄清事件和 Agent Sandbox 普通/流式兜底路径。
- 不新增业务实体、业务字段或固定功能名；Function、Plugin、事实字段和值继续作为动态不透明数据处理。
- SQLite/外部 Persistence Provider 复用已版本化的 BehaviorContext 快照，不新增业务表；待解析引用随快照和事件一起恢复。
