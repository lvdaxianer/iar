# Spec Delta

## MODIFIED Requirements

### Requirement: One route call proposes the complete candidate

The primary route SHALL use at most one model call to propose the Plugin tool, nested Function/Operation and named JSON object arguments for the current message. The outer `operation` SHALL be the only operation identity in the route envelope; the nested argument object SHALL contain business parameters only and SHALL NOT repeat `operation`.

#### Scenario: Query proposal is complete

- **WHEN** a user asks a query handled by an enabled Plugin
- **THEN** the route result contains the selected Plugin, Function, Operation and named arguments from one model call, with no duplicate operation field inside the arguments

#### Scenario: No matching candidate is proposed

- **WHEN** no enabled Plugin tool matches the current message
- **THEN** the runtime returns a bounded clarification or normal response without executing a Function

#### Scenario: Operation is missing from a matched proposal

- **WHEN** a model proposes a Plugin and Function but omits the outer Operation
- **THEN** the runtime returns a stable operation-missing result, records the allowed operations, and does not execute the Function

### Requirement: Runtime validates the complete proposal

The runtime SHALL treat the model proposal as untrusted and SHALL validate ownership, enabled state, installed input Schema, authorization, policy, confirmation and idempotency before execution. Operation identity SHALL be validated once from the outer route envelope, and any repeated operation value inside arguments SHALL be rejected when it conflicts with the outer value.

#### Scenario: Valid arguments execute the owned registration

- **WHEN** the proposal identifies an enabled Plugin and its installed Function/Operation and its arguments satisfy the installed Schema
- **THEN** only that registration receives the validated arguments

#### Scenario: Swapped or unknown argument placement is rejected

- **WHEN** the proposal has missing, extra, mistyped or semantically invalid named arguments
- **THEN** execution is blocked and the runtime returns a stable clarification or validation result

#### Scenario: Repeated operation conflicts with the route identity

- **WHEN** the outer route operation is `limit` and the nested arguments contain `operation: stats`
- **THEN** the runtime returns an operation-conflict result, does not execute the Function, and preserves both values for safe diagnostics

#### Scenario: Repeated operation is absent

- **WHEN** the outer route operation is valid and the nested arguments do not contain an operation field
- **THEN** the runtime accepts the proposal and supplies the validated outer operation to the installed Function contract without requiring the model to repeat it
