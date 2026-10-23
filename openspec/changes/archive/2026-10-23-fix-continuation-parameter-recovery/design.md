# Design

## Context

当前路由链在 `semantic.extract` 返回不完整帧时会先经过 `gateIncompleteSemanticFrame`，桥接模式下随后可能直接进入 `pass_through`。已有 `BehaviorContext.route` 和 `BehaviorContext.collection` 没有在此门禁之前恢复成 `selectedDescriptor`，所以 Function/Plugin 路由和参数收集器不会运行。该问题在短句修改、重试、确认和补参场景中表现为“没有反问、没有确认、没有执行”。

## Goals / Non-Goals

**Goals:**

- 以持久化的 Function/Plugin 标识为唯一恢复依据，优先恢复参数收集目标，再恢复稳定路由目标。
- 让恢复后的当前输入重新经过语义动作校正、Function 输入 Schema、参数收集、授权、策略、幂等和确认。
- 让前一轮已验证的命名槽位可作为补充输入，避免要求模型重复已经确定的 operation。
- 为“恢复成功、目标失效、动作不明确、参数缺失”提供可测试的结构化结果。

**Non-Goals:**

- 不添加 `ticket.create`、`api.gateway` 等业务特例或关键词到 Function 的映射。
- 不让自然语言确认绕过现有显式确认协议。
- 不让 Response Model、原始文本或模型生成的 Function/Plugin ID 改变执行目标。
- 不做额外模型调用；恢复逻辑只在已有抽取结果和 BehaviorContext 上运行。

## Decisions

### 1. 恢复顺序固定为 collection → route → clarification/pass-through

在每一轮语义抽取前，从当前 BehaviorContext 的参数收集状态精确查找 Function/Plugin descriptor；没有 collection 时，再检查当前验证过的 route 和通用连续输入标记。只有两者都不存在时，才允许现有的不完整澄清或桥接 pass-through。

### 2. 标识由注册表重新验证

恢复函数只接受已注册且当前启用、授权的 exact `functionId/pluginId`。恢复出来的 descriptor 仍会经过现有 owner、actionTypes 和 schema 校验；找不到或失效时返回稳定的 unavailable/clarification 结果。

### 3. 动作恢复只使用有限运行时证据

当前帧已有合法 action 时保留它；当前帧 action 缺失时，仅根据通用 continuation 类型和 descriptor 已声明的 actionTypes 选择可验证动作。若仍不能唯一确定，进入结构化澄清，不用 descriptor 数组第一项冒充动作。

### 4. 槽位按名称合并

构建 Function 输入时，当前帧槽位优先；对当前 Function 已验证且 Schema 允许的上下文槽位作为 fallback。operation 等路由字段可以从上下文继承，但业务参数的新值必须来自当前输入或收集器，不能按位置重排。

### 5. 只新增回归证据，不改变生产日志边界

测试覆盖桥接模式下短句连续输入不再 pass-through、参数收集恢复和失效目标拒绝。日志沿用已有 trace-correlated safe log，不记录原始输入、完整 prompt 或模型 payload。

## Risks / Trade-offs

- 通用连续词可能存在歧义：只在已有 verified collection/route 且 descriptor 唯一时启用，动作仍需声明类型匹配。
- 上下文槽位可能过期：只继承当前 Function、已验证且 Schema 兼容的命名字段；重新加载注册表后再校验。
- 真实模型仍可能漏抽新值：继续通过参数收集器反问，不通过猜测补值。

## Verification Plan

1. 先添加会在当前实现失败的 Sandbox bridge 回归测试，证明稳定路由的短句不会进入 `pass_through`。
2. 添加参数收集的 named-slot 合并测试，验证缺失字段进入 collector 且补齐后保持原 Function。
3. 添加失效/禁用目标测试，验证不执行、不回退为可执行目标。
4. 运行 focused Sandbox tests、OpenSpec strict validation、build、lint 和 full test suite。
