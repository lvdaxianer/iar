# Continuation and Parameter Recovery

## Purpose

让同一会话中的连续补充、修改和补参输入绑定到已经验证的 Function/Plugin 目标，并重新进入统一的 Schema、策略和确认流程。

## Requirements

### Requirement: Persisted target is restored before incomplete pass-through

The runtime SHALL resolve an active parameter collection first, then the current verified Function/Plugin route, before applying the semantic incomplete gate or bridge pass-through. A recovered Function SHALL be matched to the current enabled and authorized Plugin registration when the Function has a Plugin owner.

#### Scenario: Unknown semantic frame continues a verified route

- **WHEN** semantic extraction returns unknown intent or action and BehaviorContext contains a verified route
- **THEN** Runtime restores the exact Function and Plugin, preserves a legal action or enters structured clarification, and does not return pass-through solely because the frame is incomplete

#### Scenario: Stable route recovers a generic continuation

- **WHEN** the current session has a verified Function/Plugin route and the user sends a generic continuation such as modifying, retrying or executing the current request, but semantic extraction omits intent or action
- **THEN** the runtime restores that exact registered target and does not return `pass_through` solely because the current frame is incomplete

#### Scenario: Parameter collection keeps its Function target

- **WHEN** a parameter collection is active and the next user input supplies or changes a field without naming the Function
- **THEN** the runtime keeps the collection's Function/Plugin target and sends the new value through the same installed input Schema

#### Scenario: Function exists but its Plugin is unavailable

- **WHEN** a persisted Function resolves to a disabled, missing or unauthorized Plugin
- **THEN** Runtime returns stable unavailable or clarification state and never invokes the Function Handler or asks a model to fabricate execution

### Requirement: Recovered targets remain non-authoritative

Target recovery SHALL only reuse identifiers already present in validated BehaviorContext and the current enabled registry; it SHALL NOT accept a new target, capability, or ownership from the Response Model or raw continuation text.

#### Scenario: Stale or disabled target is rejected

- **WHEN** the persisted target no longer resolves to an enabled authorized registration
- **THEN** the runtime clears the executable recovery path and returns a bounded unavailable or clarification result without invoking a Handler

### Requirement: Context slots are merged by named schema fields

Recovered parameter values SHALL be merged by declared field name, with current-turn values taking precedence over previously validated values. Unknown names, invalid types, invalid enum values and missing required fields SHALL remain unexecutable and SHALL produce structured parameter clarification. A clarified Operation SHALL be stored as a named slot on the existing Function/Plugin collection and SHALL not require the user or model to repeat unrelated fields.

#### Scenario: Current field overrides history

- **WHEN** a collection contains a validated historical field and the current input supplies the same field with a schema-compatible value
- **THEN** the current value is retained and the historical value cannot overwrite it

#### Scenario: Operation identity is inherited while a new parameter is collected

- **WHEN** a previous validated route established an operation and a continuation supplies only a new operation parameter
- **THEN** the runtime keeps the prior named operation field, validates the new parameter by name and continues to policy/confirmation without asking the model to repeat the operation positionally

#### Scenario: User cancels parameter collection

- **WHEN** a user declines to provide a requested parameter or starts a new topic
- **THEN** Runtime clears the collection and pending action, records the cancellation/new-topic event and does not execute the prior Function

#### Scenario: Operation answer preserves the verified target

- **WHEN** a parameter collection or Operation clarification is active and the next user input supplies one allowed Operation
- **THEN** the runtime keeps the original Function/Plugin target, merges the Operation by name, and asks only for remaining required parameters

#### Scenario: Completed clarification enters normal gates

- **WHEN** the Operation and required parameters become valid after one or more same-session turns
- **THEN** the runtime re-runs installed Schema validation, authorization, policy, idempotency and confirmation before any Handler invocation

#### Scenario: Invalid Operation answer remains blocked

- **WHEN** the next input is not one of the active Function's allowed Operations
- **THEN** the runtime preserves a bounded Operation clarification, does not switch Plugin/Function, and does not execute a Handler

### Requirement: Recovery cannot bypass policy or confirmation

Recovered continuation input SHALL re-enter normal Function input validation, authorization, policy, idempotency and confirmation gates; recovery alone SHALL never execute a side effect.

#### Scenario: Recovered high-risk update waits for confirmation

- **WHEN** a recovered continuation forms a valid high-risk Function input
- **THEN** the runtime stores the pending action and asks for the existing confirmation, without invoking the Handler before confirmation

### Requirement: Unresolved continuation is structured

When a verified target exists but the action type or required parameter remains ambiguous, the runtime SHALL create a bounded structured clarification tied to that target and SHALL not route the input to Pi as if it were an unrelated conversation.

#### Scenario: Missing parameter produces a collector request

- **WHEN** the Function is known but a required field is missing after current and inherited named values are merged
- **THEN** the runtime persists the parameter collection state and asks for that field using the declared presentation metadata

### Requirement: Pending workflows accept only explicit safe transitions

When a confirmation or parameter collection is pending, Runtime SHALL inspect the current turn for an explicit cancellation or a valid continuation before returning the pending guard. A cancellation SHALL clear the pending workflow, record the cancellation event, and never invoke the pending Function. Ambiguous text SHALL remain pending and SHALL require an explicit confirmation or cancellation action.

#### Scenario: Natural-language withdrawal cancels a pending ticket

- **WHEN** a ticket-create action is awaiting confirmation and the user says “算了，不建了”
- **THEN** Runtime clears the pending action, reports cancellation, and the ticket handler is not called

#### Scenario: Unrelated text cannot cancel a pending action

- **WHEN** an action is awaiting confirmation and the user sends a new topic or an ambiguous acknowledgement such as “好的”
- **THEN** Runtime leaves the pending action intact and does not execute or silently discard it

#### Scenario: Explicit confirmation remains separate

- **WHEN** an action is awaiting confirmation and the user sends “确认”
- **THEN** Runtime applies confirmation only to the pending action and invokes the existing confirmation path exactly once

### Requirement: Incremental continuation restores the verified target

在已验证 Function/Plugin 路由存在且当前输入明确表达对该目标的增量修改、继续调整或重试时，Runtime SHALL 先恢复该目标并收集当前轮参数，再应用语义不完整门禁或 Pi pass-through。恢复后的输入 SHALL 重新经过 Schema、授权、策略和确认流程。

#### Scenario: Incremental numeric continuation restores the target

- **WHEN** 当前会话已经成功执行 API 网关限流调整，且用户说“再往上调 50”或等价的增量表达
- **THEN** Runtime 复用已验证的 API 网关目标，将当前值与增量语义合成为新的明确参数，形成新的待确认动作，不得转为 Pi pass-through 或把 50 当作绝对值

#### Scenario: Incremental continuation remains fail-closed

- **WHEN** 增量表达无法确定目标或单位
- **THEN** Runtime 请求有限澄清，不执行动作、不猜测数值，也不把输入交给无关能力
