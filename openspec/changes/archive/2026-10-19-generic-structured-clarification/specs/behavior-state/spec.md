# Spec Delta

## MODIFIED Requirements

### Requirement: BehaviorContext preserves critical execution state

The current behavior state SHALL preserve subject identity and reference provenance, intent, action, Function, selected Plugin, slots, workflow step, pending input including bounded clarification metadata, confirmation state, idempotency key, and integrity metadata.

#### Scenario: Reference resolution survives later input

- **WHEN** a previous event resolves “第一个服务” to stable subject `test1`
- **THEN** a later input can recover `subject.id=test1` and the source event without reinterpreting the original list

#### Scenario: Pending clarification survives later input

- **WHEN** response generation asks the user to choose from a finite option set
- **THEN** the pending kind, status and validated options are present in the BehaviorContext for the next turn

#### Scenario: Invalid pending metadata is rejected

- **WHEN** an event or restored snapshot contains invalid, oversized or duplicate clarification options
- **THEN** projection or restoration rejects that state and keeps the last valid BehaviorContext

#### Scenario: Pending state does not authorize execution

- **WHEN** a pending clarification option names a possible interpretation but no new validated route and policy decision exists
- **THEN** the runtime does not execute a Function or Plugin solely from the pending option

