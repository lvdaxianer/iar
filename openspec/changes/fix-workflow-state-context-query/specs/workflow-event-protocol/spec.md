# Spec Delta

## MODIFIED Requirements

### Requirement: Workflow decisions are versioned and non-authoritative

The semantic extraction contract SHALL optionally return bounded `userIntent` and `event` enums. It SHALL support a `context_answered` event for a read-only answer from verified session context. Context-answer events SHALL not authorize a Function, Plugin, Schema, permission, policy result, confirmation or next executable state.

#### Scenario: Context question is classified

- **WHEN** the current user message asks for a value or status already present in verified facts
- **THEN** the model may return `userIntent=answer_context` and `event=context_answered`, and Runtime keeps the workflow position unchanged

#### Scenario: Parameter answer is classified

- **WHEN** the current workflow is collecting parameters and the user supplies a field value
- **THEN** the model may return `userIntent=provide_parameter` and `event=parameter_received`, while Runtime still validates the named field against the installed Function Schema

#### Scenario: User abandons collection

- **WHEN** the user says they no longer wants to fill the requested fields
- **THEN** the model may return `cancel_workflow` with `workflow_cancelled`, and Runtime clears pending collection without executing a Function

#### Scenario: Model proposes an unknown event

- **WHEN** the model returns an unknown or malformed workflow event
- **THEN** Runtime normalizes it to `unknown`, rejects unsafe transitions and does not execute a Function

#### Scenario: Model attaches an incompatible event to a context answer

- **WHEN** a context answer contains another bounded event such as a confirmation event
- **THEN** Runtime normalizes the context answer to a non-transition disposition and does not execute a Function from that event

### Requirement: Runtime computes the authoritative next state

Runtime SHALL derive the active workflow position from validated BehaviorContext and SHALL compute transitions using a finite map. Terminal outcomes SHALL reopen the semantic boundary for a new turn, while active parameter collection and confirmation states SHALL continue to reject illegal jumps.

#### Scenario: Terminal workflow receives a new request

- **WHEN** the current outcome is completed, cancelled or failed and the model reports any bounded current-turn event
- **THEN** Runtime does not reject the turn solely because that event is not a continuation of the old workflow; the new semantic frame still passes all normal routing and execution gates

#### Scenario: Legal parameter transition

- **WHEN** a parameter collection receives a schema-compatible value but still has missing fields
- **THEN** Runtime remains in parameter collection and returns a structured request for the remaining fields

#### Scenario: Illegal execution transition

- **WHEN** a model returns an execution-like event while the current state is collecting parameters or awaiting confirmation
- **THEN** Runtime rejects the transition and does not invoke policy execution or a Handler
