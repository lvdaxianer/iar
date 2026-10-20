# 通用模型决策与结构化上下文回答设计

## 核心原则

模型负责理解问题和选择有限候选；程序负责候选边界、权限、策略、执行和持久化。程序不根据工单、人工、排名等业务关键词写分支。

## 流程

```text
用户问题
  ↓
当前问题 + BehaviorContext
  ↓
语义模型判断 actionType
  ↓
按 scope、生命周期、权限、actionType 过滤 Plugin/Function 候选
  ↓
模型选择有限 Plugin / Function
  ├─ 查询 Function → 执行只读查询并生成回复
  ├─ 新动作 Function → 权限、策略、确认后执行
  └─ 无匹配/低置信度/unknown → 回答模型直接回答或反问
  ↓
异步更新 BehaviorContext，并按 sessionId 持久化
```

## 关键约束

- `intent` 描述能力领域，`actionType` 描述本轮操作性质，二者不能混用。
- 没有合适候选时直接进入回答模型，不为了凑出路由而选择业务动作。
- 回答模型只能使用 verified facts；没有事实时必须澄清。
- 任何候选之外的选择、动作类型不兼容、权限或策略失败，都 fail-closed。
- 普通和流式入口必须共享相同的执行结论。

## 示例

上一步已经产生事实 `queuePosition=3`，用户输入“我是第几个呢”时：

```text
actionType=query
→ 没有合适业务 Function
→ 没有匹配 Function，进入 fallback
→ 回答模型读取 queuePosition=3
→ 回复“你当前排在第 3 位”
```

如果用户说“帮我重新转人工”，则模型判断为 `transfer`，正常进入原有 Function、Plugin、确认和执行链路。
