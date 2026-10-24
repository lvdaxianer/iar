# Proposal

## Why

在同一 Pi/IAR 会话中突然切换话题时，运行时会把缺少明确对象的泛查询或新操作继续绑定到上一轮 Function。真实 8878 链路已复现：用户切出工单话题后，系统仍回答旧工单，极端情况下还会再次创建工单，破坏用户对当前问题的预期。

## What Changes

- 收紧连续路由恢复条件：只有当前输入有明确指代、参数补充或稳定的动作续改证据时，才继承旧 Function。
- 对没有对象、没有有效指代的泛查询返回有界澄清，不自动读取或执行上一话题。
- 保留明确新对象和明确新操作的正常路由、确认和执行边界。
- 增加普通会话、Bridge 入口和真实 8878 链路的突然切题回归证据。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `continuation-recovery`: 旧目标只能在当前输入明确表达连续语义时恢复；泛查询不得吸附到旧 Function。
- `structured-model-context`: 当前用户问题优先于旧事实和最近消息，缺少对象时必须澄清而不是替旧话题回答或执行。

## Impact

- 影响 `examples/agent-sandbox/src/session-clarification.ts` 的连续路由恢复。
- 增加 `tests/integration/agent-sandbox` 回归测试。
- 不改变公开 HTTP/Bridge 字段，不改变已有确认、取消和事实追问契约。
