# Spec Delta

## MODIFIED Requirements

### Requirement: Persisted target is restored before incomplete pass-through

The runtime SHALL resolve an active parameter collection first, then the current verified Function/Plugin route, before applying the semantic incomplete gate or bridge pass-through. A recovered Function SHALL be matched to the current enabled and authorized Plugin registration when the Function has a Plugin owner. Recovery SHALL only occur when the current input contains explicit continuation evidence such as a validated reference, a parameter correction, or an execution continuation; a generic query without an object or reference SHALL not inherit the previous route.

#### Scenario: Generic query after a completed action is clarified

- **WHEN** a session has a verified prior route and the user sends a generic query such as “可以帮我查询下吧” without naming an object or referring to a prior result
- **THEN** Runtime SHALL not restore the prior Function, SHALL not prepare or execute an action, and SHALL return a bounded clarification asking what the user wants to query

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

#### Scenario: Explicit new topic wins over a stable route

- **WHEN** the current input contains a new supported object or operation that differs from the previous route
- **THEN** Runtime SHALL route the current input using its own validated semantic evidence and SHALL not let the previous Function override it

#### Scenario: Explicit continuation still restores the verified target

- **WHEN** the user explicitly refers to a prior result or supplies a parameter correction such as “刚才那张工单的进度” or “改成每秒 200 次”
- **THEN** Runtime SHALL restore only the verified prior target when the current input is compatible, then re-enter normal read, validation, policy and confirmation gates

#### Scenario: Recovered targets remain non-authoritative

- **WHEN** a recovered target is considered for the current turn
- **THEN** Runtime SHALL reuse only identifiers already present in validated BehaviorContext and the current enabled registry, and SHALL not accept a new target or ownership from raw continuation text

#### Scenario: Stale or disabled target is rejected

- **WHEN** the persisted target no longer resolves to an enabled authorized registration
- **THEN** the runtime clears the executable recovery path and returns a bounded unavailable or clarification result without invoking a Handler

#### Scenario: Current field overrides history

- **WHEN** a collection contains a validated historical field and the current input supplies the same field with a schema-compatible value
- **THEN** the current value is retained and the historical value cannot overwrite it

#### Scenario: Operation identity is inherited while a new parameter is collected

- **WHEN** a previous validated route established an operation and a continuation supplies only a new operation parameter
- **THEN** the runtime keeps the prior named operation field, validates the new parameter by name and continues to policy/confirmation without asking the model to repeat the operation positionally

#### Scenario: User cancels parameter collection

- **WHEN** a user declines to provide a requested parameter or starts a new topic
- **THEN** Runtime clears the collection and pending action, records the cancellation/new-topic event and does not execute the prior Function

#### Scenario: Recovered high-risk update waits for confirmation

- **WHEN** a recovered continuation forms a valid high-risk Function input
- **THEN** the runtime stores the pending action and asks for the existing confirmation, without invoking the Handler before confirmation

#### Scenario: Missing parameter produces a collector request

- **WHEN** the Function is known but a required field is missing after current and inherited named values are merged
- **THEN** the runtime persists the parameter collection state and asks for that field using the declared presentation metadata
