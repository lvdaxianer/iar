# Design

## Context

See `proposal.md` for the user-visible problem. 当前 Runtime 已经有可重放的
`BehaviorContext` 和按 `sequence` 保存的 `factHistory`，但 `recentMessages`
只是有界原文窗口，不能表达稳定的“第几轮对话”，历史引用协议也只面向
业务事实。普通和流式 Agent Sandbox 入口最终都通过 `pushMessages` 写入
最近消息，因此可以在该完成边界统一记录一轮对话。

## Goals / Non-Goals

**Goals:**

- 将一轮定义为一次用户输入及其最终助手回复，并用稳定 ID 和单调序号表达。
- 在 BehaviorContext 快照和事件回放中恢复有界的轮次历史及当前轮次焦点。
- 让模型同时看到有序对话轮次和有序业务事实，并由模型输出引用范围。
- 由 Runtime 校验引用目标、序号、关系、会话归属和副作用授权边界。
- 普通与流式入口、刷新恢复、压缩恢复保持一致。

**Non-Goals:**

- 不把原始对话文本升级为可信业务事实或执行授权。
- 不新增依赖、不改变外部 HTTP API、不重写 Plugin/Function 路由协议。
- 不通过业务关键词表解决自然语言理解，也不在 Runtime 复制模型的语言理解能力。
- 不为历史会话补造无法从持久化消息或事件可靠配对的轮次。

## Decisions

### 1. 在 BehaviorContext 中增加独立的 turn history

新增有界 `ConversationTurnHistory`，包含 `turns`、`focusTurnId` 和每条
`ConversationTurn` 的 `turnId`、`sequence`、有界 user/assistant 文本、结果
状态、是否产生 Action 及可选的已验证事实 ID。它与 `factHistory` 使用不同
的序号命名空间，分别表达“问题顺序”和“业务结果顺序”。

选择放入 BehaviorContext 而不是只拼装 `recentMessages`，因为快照、压缩
和重启都必须恢复同一序号；原始消息仍作为非权威补充窗口保留。

### 2. 以完成事件作为轮次事实源

新增 `conversation.turn.completed` 事件。会话只有在最终回复完整可提交时
才追加事件并投影轮次；流式中断、模型超限或只有中间增量时不追加完成轮次。
事件载荷携带已经有界的 user/assistant 文本和结果元数据，不携带模型原始
请求、思考内容或执行密钥。重复事件按 `turnId` 幂等，旧序号或跨会话目标
被投影器拒绝。

选择完成事件而不是直接从消息数组推断，是为了避免用户消息和助手增量在
断流、重试、确认等待等场景下被错误配成一轮；现有 `recentMessages` 继续
由消息持久化策略管理，不取代事件投影。

### 3. 扩展引用为带 scope 的数据契约

历史引用新增 `scope: conversation_turn | fact_history`，并允许使用稳定
目标 ID、序号或有限关系。语义模型负责把自然语言解释成 scope/relation；
Runtime 只按当前会话的对应集合解析和校验，不从用户原文维护固定关键词分支。

解析失败时沿用现有 bounded clarification/pending reference 流程，不猜测、
不把另一条集合当作兜底集合。已解析的引用只进入只读回复或参数准备，仍
不能绕过现有 route、policy、confirmation 和 idempotency 门禁。

### 4. 模型输入采用两个有序分栏

语义抽取、兜底回复和 Response Generator 都接收有界的：

- `conversationTurns`：按 `sequence` 升序，提供 turn ID、序号、问题、回答、结果。
- `factHistory`：按 `sequence` 升序，提供 record ID、序号、Function/Plugin 和可信 values。
- `focus`：分别提供当前 turn 和当前 fact 的不透明 ID。

提示词明确两条序号是不同命名空间，模型只能选择输入中存在的对象。最近
消息仍可辅助理解省略，但不能改变上述顺序或产生新目标。

### 5. 兼容旧快照和持久化数据

旧版 BehaviorContext 没有 `conversationTurns` 时按空轮次历史读取，不阻塞
已有 factHistory。恢复入口可以使用已持久化、可明确成对的 user/assistant 消息
生成有界兼容视图；无法明确配对时不补造 turn ID，模型只能获得已有可信事实
并按现有澄清流程处理。新事件和新快照使用同一版本化契约，Provider 不需要
新增数据库列。

## Risks / Trade-offs

- [Risk] 轮次文本扩大快照体积。→ 使用独立的消息/字段长度和记录数量上限，
  并在模型输入前再次按上限投影。
- [Risk] 旧数据缺少完整轮次边界。→ 只恢复可验证的相邻 user/assistant 对，
  无法确认时保持空轮次而不是猜测。
- [Risk] 模型仍可能输出错误 scope 或不存在的 ID。→ 所有引用先经过
  schema、会话归属、序号范围和集合校验；失败进入有限澄清，禁止执行。
- [Risk] 普通与流式完成边界产生漂移。→ 两个入口共用同一个 turn completion
  记录器，并用同一组回归测试验证事件序列和上下文输入。
- [Risk] 压缩结果遗漏新字段。→ 关键字段哈希包含 turn history，压缩校验要求
  保留轮次集合和焦点；无效压缩继续保留上一份有效状态。

## Migration Plan

1. 先扩展合同、事件和投影器，保留旧快照可读取能力。
2. 再接入普通/流式会话的完成事件和模型输入投影。
3. 最后接入 scope-aware 引用解析、提示词和集成回归测试。
4. 发布时不需要数据库迁移；旧快照按兼容规则读取，新请求从下一次完整
   user/assistant 回复开始建立轮次历史。
5. 如需回滚，保留旧字段读取路径并停止产生新轮次事件；已有事实链和旧消息
   行为不受影响。
