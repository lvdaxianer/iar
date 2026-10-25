# Spec Delta

## MODIFIED Requirements

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
