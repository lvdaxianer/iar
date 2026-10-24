# Design

## 状态模型

运行时区分两类信息：

- `activeState`：`normal`、`function_selection`、`collecting_parameters`、`awaiting_confirmation`、`executing`，只描述当前仍可继续的流程。
- `outcome`：`completed`、`cancelled`、`failed` 或空值，描述最近一次流程结果，不再作为下一轮输入的阻塞状态。

现有 `currentState` 保持兼容投影，但终态上下文同时暴露 outcome。终态收到新输入时，运行时允许重新分类；任何新副作用仍必须经过 Function/Plugin、Schema、权限、policy、幂等和 confirmation 门禁。

## 只读上下文事件

Workflow decision 增加 `context_answered` 事件。`userIntent=answer_context` 或该事件只表示当前输入可以从可信上下文回答，Runtime 不把它当作执行迁移。模型输出的其他事件仍然是非权威数据；对已结束流程的错误事件不阻塞新语义帧，但不能直接授权执行。

## 事实追问归一化

在普通和流式入口的共同处理顺序中，先根据 `factHistory`、当前文本的通用指代/事实询问特征和 `query/unknown` action 判断是否为已验证事实追问。命中时将当前帧归一化为 `intent=unknown`、`action=query`、`userIntent=answer_context`，并丢弃模型创建的 plugin 标识；随后继续引用解析、事实回复和 Pi pass-through 门禁。

只有运行时已有可信事实时才进行该归一化；显式新操作、参数补充、确认和取消不被降级为查询。

## 安全边界

- 参数收集中的确认跳转仍然拒绝。
- 等待确认中的新输入不能因为终态规则而直接执行旧动作。
- Response Model 文字不参与状态迁移或授权。
- 事实查询无可验证记录时仍进入澄清，不编造结果，也不创建 Function。
- 普通和 streamed turn 调用同一个归一化与 Workflow decision 分类函数。

## 验证

- 先运行新增状态/协议测试确认 RED，再实现 GREEN。
- 运行 build、lint、目标 Agent Sandbox 测试和全量 npm test。
- 启动 `npm run demo:sandbox`，按用户提供的 24 组清单至少核验事实记忆、连续补参、空会话防编造、确认边界、列表指代和压缩后追问。
