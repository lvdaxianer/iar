# Spec Delta

## MODIFIED Requirements

### Requirement: Workflow decisions are versioned and non-authoritative

The semantic extraction contract SHALL optionally return a versioned workflow decision containing bounded `userIntent` and `event` enums. The decision SHALL describe the current user interaction only and SHALL NOT grant execution authority or introduce Function, Plugin, Schema, permission or next-state values.

#### Scenario: Parameter answer is classified

- **WHEN** the current workflow is collecting parameters and the user supplies a field value
- **THEN** the model may return `userIntent=provide_parameter` and `event=parameter_received`, while Runtime still validates the named field against the installed Function Schema

#### Scenario: User abandons collection

- **WHEN** the user says they no longer wants to fill the requested fields
- **THEN** the model may return `cancel_workflow` with `workflow_cancelled`, and Runtime clears pending collection without executing a Function

#### Scenario: Model proposes an unknown event

- **WHEN** the model returns an unknown or malformed workflow event
- **THEN** Runtime normalizes it to `unknown`, rejects unsafe transitions and does not execute a Function

### Requirement: Runtime computes the authoritative next state

Runtime SHALL derive the current workflow state from validated BehaviorContext and SHALL compute the next state using a finite transition map. Model-provided `nextState` or transition suggestions SHALL never override the Runtime result.

#### Scenario: Legal parameter transition

- **WHEN** a parameter collection receives a schema-compatible value but still has missing fields
- **THEN** Runtime remains in parameter collection and returns a structured request for the remaining fields

#### Scenario: Illegal execution transition

- **WHEN** a model returns an execution-like event while the current state is collecting parameters or awaiting confirmation
- **THEN** Runtime rejects the transition and does not invoke policy execution or a Handler
