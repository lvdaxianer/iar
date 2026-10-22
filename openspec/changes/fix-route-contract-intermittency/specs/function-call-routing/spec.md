# Spec Delta

## MODIFIED Requirements

### Requirement: Function identity and arguments are separate contracts

The runtime SHALL validate the canonical Function identity independently from the named argument object, and SHALL use only the installed Function input Schema to construct an Action. The route envelope's outer Operation SHALL remain the canonical operation identity; the model SHALL NOT be required to repeat it inside the argument object.

#### Scenario: Canonical Function with valid named arguments

- **WHEN** the model returns `ticket.create` and an object whose fields satisfy the installed input Schema
- **THEN** the runtime constructs the Action with those named arguments and does not remap them by position or natural-language labels

#### Scenario: Correct values assigned to the wrong fields

- **WHEN** the model returns valid-looking values under the wrong named fields
- **THEN** Schema and semantic validation reject the proposal or request clarification before execution

#### Scenario: Outer operation is injected into the installed contract

- **WHEN** the route envelope contains a validated operation and the named arguments contain only business fields
- **THEN** the runtime supplies the validated operation to the installed Function contract without asking the model to duplicate it

#### Scenario: Conflicting repeated operation is rejected

- **WHEN** the route envelope and the named arguments contain different operation values
- **THEN** the runtime returns a stable operation-conflict validation result and does not construct or execute an Action

## ADDED Requirements

### Requirement: Function-call contract failures are classified

The runtime SHALL classify invalid model proposals with stable reason codes and SHALL preserve the safe expected and actual identity values needed for diagnosis.

#### Scenario: Operation is missing

- **WHEN** a matched Function proposal has no usable outer operation
- **THEN** the runtime returns `operation_missing` with the bounded allowed operation IDs and does not execute the Function

#### Scenario: Operation is not allowed

- **WHEN** the proposal operation is not registered for the selected Plugin and Function
- **THEN** the runtime returns `operation_not_allowed` with the selected identity and bounded allowed operation IDs

#### Scenario: Operation values conflict

- **WHEN** the outer operation and a repeated argument operation differ
- **THEN** the runtime returns `operation_conflict` with the outer and nested values and blocks execution

#### Scenario: Contract failure is observable without raw model data

- **WHEN** any of the preceding contract failures occurs
- **THEN** the runtime emits a trace-correlated diagnostic containing stage, model role, expected values, actual values and decision, while omitting the raw prompt, full model response and credentials
