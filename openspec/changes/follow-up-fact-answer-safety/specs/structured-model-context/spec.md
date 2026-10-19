# Spec Delta

## MODIFIED Requirements

### Requirement: Models can answer from verified facts without repeating actions

The system SHALL separate semantic intent from the fixed action type and let models choose among finite Plugin/Function candidates using the current message and structured context. When no suitable Function is selected, the system SHALL let the response model answer from verified facts or ask a bounded clarification; it SHALL NOT infer or execute a business-specific side effect from a noun or historical reference.

#### Scenario: Ask for a previous result

- **WHEN** any successful action has produced a verified result and the user asks for one of its values
- **THEN** the runtime skips unrelated business actions and the response model can answer from the verified result without invoking or confirming a second side effect

#### Scenario: Ask for the previous ticket number

- **WHEN** a ticket was successfully created and the user asks for its number
- **THEN** the model can answer using the identifier from that successful event without invoking or confirming a second ticket creation

#### Scenario: Other business results work the same way

- **WHEN** a user asks about a prior successful result in another supported subsystem
- **THEN** the same generic fact and decision mechanism supports answering without a subsystem-specific rule

#### Scenario: The question has no matching Function

- **WHEN** the current action type and structured question do not produce a suitable Function candidate
- **THEN** the runtime skips action preparation and execution and asks the response model to answer from context or request clarification

#### Scenario: A model selects a supported new operation

- **WHEN** a supported new operation is selected from the finite candidates
- **THEN** the runtime preserves the existing Function, Plugin, authorization, policy and confirmation checks

#### Scenario: A genuinely new operation is requested

- **WHEN** a supported new operation is selected
- **THEN** existing authorization, policy and confirmation checks remain in force

#### Scenario: Candidate action types are incompatible

- **WHEN** a model selects a Function or Plugin that does not support the structured action type or is not in the finite candidate set
- **THEN** the decision is rejected without execution and the response model receives the current question and structured context

#### Scenario: Insufficient or ambiguous evidence

- **WHEN** available facts do not establish the intended result or contain the requested value
- **THEN** the model is instructed to express uncertainty or ask for clarification instead of inventing a value or initiating a side effect
