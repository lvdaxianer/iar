# Proposal

## Why

当用户在同一会话中继续补充参数、修改刚才的值或确认执行时，语义模型偶发返回不完整帧。当前运行时会在恢复已有路由之前把这类输入判定为 `pass_through` 或通用澄清，导致 Function 选择和参数收集器没有机会接管，用户既看不到正确的反问，也无法完成确认后的执行。

## What Changes

- 在语义不完整门禁之前，优先从已验证的参数收集状态和稳定路由恢复目标 Function/Plugin 标识。
- 对连续输入只使用已持久化的注册表标识，不从自然语言生成或猜测新的 Function、Plugin 或权限。
- 将恢复后的输入重新送入现有动作类型、OpenAI-compatible Schema、参数收集、策略和确认流程。
- 合并已验证的上下文槽位作为补充输入，但只继承可证明属于当前 Function 的字段；当前轮新值仍覆盖旧值并经过 Schema 校验。
- 对无法确定动作类型或参数的输入返回结构化澄清，不再把它作为 Pi 兜底文本直接结束。
- 保留现有待确认动作的显式确认协议，不把 Response Model 的文字当作执行授权。

## Capabilities

### New Capabilities

- `continuation-recovery`: 在稳定 Function/Plugin 路由和参数收集状态下恢复连续输入，并重新进入受约束的路由、补参、策略与确认链。

### Modified Capabilities

- `behavior-state`: 已持久化的路由与参数收集状态必须能驱动后续输入的目标恢复。
- `bounded-routing`: 语义帧不完整时，必须先尝试基于已验证状态的有限目标恢复，再决定澄清或 Pi 兜底。
- `function-call-routing`: 连续补参必须继续使用已选 Function 的安装 Schema 和命名字段契约。

## Impact

- 影响 `examples/agent-sandbox` 的 turn、routing、clarification 和 parameter collector 边界。
- 增加 Sandbox 集成回归测试和 OpenSpec 规格，不新增业务关键词分支或业务能力。
- 不改变 Plugin/Function 注册格式、JEV/Intent Model 选择优先级、执行授权边界或显式确认协议。
