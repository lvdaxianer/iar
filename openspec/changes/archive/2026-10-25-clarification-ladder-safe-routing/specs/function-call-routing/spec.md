# Spec Delta

## MODIFIED Requirements

### Requirement: Function-call arguments use the installed input Schema

When required arguments are missing, types are invalid, additional properties are present, or values are assigned to the wrong named field, the runtime SHALL return a bounded clarification or stable validation failure and SHALL NOT execute the Function. Operation absence SHALL be represented separately from ordinary schema parameters so the user receives the registered Operation catalog rather than a generic `operation` field prompt.

#### Scenario: Valid arguments become Action input

- **WHEN** the proposal names an owned Function and its arguments satisfy the installed input Schema
- **THEN** the validated arguments are the only input used to construct the Action

#### Scenario: Invalid arguments require clarification

- **WHEN** required arguments are missing, types are invalid, or additional properties are present
- **THEN** the runtime returns a bounded clarification or stable validation failure and does not execute the Function

#### Scenario: Invalid or misplaced arguments require clarification

- **WHEN** required arguments are missing, types are invalid, additional properties are present, or values are assigned to the wrong named field
- **THEN** the runtime returns a bounded clarification or stable validation failure and does not execute the Function

#### Scenario: Operation clarification is catalog-based

- **WHEN** a selected Function has more than one allowed Operation and the proposal has no unique current-turn Operation
- **THEN** the runtime returns `operation_missing`, includes bounded allowed Operation IDs in route evidence, and asks only for that Function's Operation choice

#### Scenario: Business parameters remain deferred

- **WHEN** the Operation is missing and business parameters are also missing
- **THEN** the runtime asks for the Operation first, does not guess business parameters, and does not create a pending Action
