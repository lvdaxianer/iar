# semantic-routing-recovery Specification

## Purpose
为语义抽取不完整、上下文确认不明确和候选路由失败提供可追踪且可恢复的运行时边界，确保只有通过结构化校验的请求才能进入 Function 执行。

## Requirements

### Requirement: Incomplete semantic frames are classified before routing

The runtime SHALL validate the semantic frame against the fields required for routing before proposing or executing a Function, and SHALL expose a stable missing-field classification when the frame is incomplete.

#### Scenario: Action is missing from an otherwise actionable request
- **WHEN** semantic extraction returns an unknown or absent action for a message that has no validated route
- **THEN** the runtime records the missing action field, skips route proposal and execution, and returns a bounded clarification state

#### Scenario: Complete frame enters routing
- **WHEN** semantic extraction returns a valid action and the remaining route prerequisites are present
- **THEN** the runtime may start candidate routing, while preserving the semantic frame as non-authoritative input to later validation

### Requirement: Runtime owns recovery questions

When required routing fields are missing, the runtime SHALL generate a finite request for the missing fields from validated context and SHALL NOT treat a response-model answer as an executable route.

#### Scenario: Missing fields can be completed from finite context
- **WHEN** the runtime knows a bounded set of possible operations or pending choices but the current semantic frame lacks one required field
- **THEN** the user receives a structured clarification naming the missing field or finite choices, and no Function or Plugin is executed

#### Scenario: Model fallback cannot authorize execution
- **WHEN** a response model produces natural language while the semantic frame remains incomplete
- **THEN** the runtime preserves the incomplete state and requires a new validated semantic frame before execution

### Requirement: Repeated clarification has a bounded escalation path

The runtime SHALL track repeated unresolved routing attempts and SHALL escalate to finite runtime-derived options or a safe terminal explanation instead of repeating an unbounded generic clarification.

#### Scenario: Repeated confirmation still lacks a route
- **WHEN** a user repeats confirmation language but no pending validated action or complete semantic frame exists
- **THEN** the runtime records the unresolved reason and asks for the specific missing route information without executing a side effect

#### Scenario: No authorized option exists
- **WHEN** escalation is reached but no enabled and authorized candidate can satisfy the missing field
- **THEN** the runtime returns a stable unavailable explanation and does not fabricate a Function, Plugin or operation
