# Continuation and Parameter Recovery

## Purpose

让同一会话中的连续补充、修改和补参输入绑定到已经验证的 Function/Plugin 目标，并重新进入统一的 Schema、策略和确认流程。

## Requirements

### Requirement: Persisted target is restored before incomplete pass-through

When the current semantic frame is incomplete, the runtime SHALL first resolve a target from the active parameter collection or the current verified route using exact registered Function and Plugin identifiers. Only when no safe target exists MAY it use generic clarification or bridge pass-through.

#### Scenario: Stable route recovers a generic continuation

- **WHEN** the current session has a verified Function/Plugin route and the user sends a generic continuation such as modifying, retrying or executing the current request, but semantic extraction omits intent or action
- **THEN** the runtime restores that exact registered target and does not return `pass_through` solely because the current frame is incomplete

#### Scenario: Parameter collection keeps its Function target

- **WHEN** a parameter collection is active and the next user input supplies or changes a field without naming the Function
- **THEN** the runtime keeps the collection's Function/Plugin target and sends the new value through the same installed input Schema

### Requirement: Recovered targets remain non-authoritative

Target recovery SHALL only reuse identifiers already present in validated BehaviorContext and the current enabled registry; it SHALL NOT accept a new target, capability, or ownership from the Response Model or raw continuation text.

#### Scenario: Stale or disabled target is rejected

- **WHEN** the persisted target no longer resolves to an enabled authorized registration
- **THEN** the runtime clears the executable recovery path and returns a bounded unavailable or clarification result without invoking a Handler

### Requirement: Context slots are merged by named schema fields

When a recovered Function needs fields from an earlier validated turn, the runtime MAY inherit only named, schema-compatible context slots. Current-turn values SHALL take precedence, and missing, misplaced, unknown, or type-invalid values SHALL enter parameter clarification rather than positional remapping.

#### Scenario: Operation identity is inherited while a new parameter is collected

- **WHEN** a previous validated route established an operation and a continuation supplies only a new operation parameter
- **THEN** the runtime keeps the prior named operation field, validates the new parameter by name and continues to policy/confirmation without asking the model to repeat the operation positionally

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
