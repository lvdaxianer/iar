# Spec Delta

## MODIFIED Requirements

### Requirement: Each session has isolated and current structured context

The system SHALL maintain separate structured state for each session and update it from accepted events before the next decision in that session. Successful actions SHALL produce traceable facts only from the plugin's explicitly declared, bounded fact envelope; failed or unconfirmed actions SHALL NOT be represented as successful facts. Session lifecycle and storage SHALL be bounded, and concurrent turns SHALL NOT observe partially updated same-session state.

#### Scenario: A successful result becomes a fact

- **WHEN** an action completes successfully and its plugin explicitly exposes bounded primitive facts
- **THEN** those facts and their event provenance are available to subsequent decisions in the same session

#### Scenario: Sessions are isolated

- **WHEN** two sessions perform operations or ask follow-up questions
- **THEN** neither session receives the other session's facts or state

#### Scenario: An action is unsuccessful or awaits confirmation

- **WHEN** an action fails or has not yet been confirmed and executed
- **THEN** it is not recorded as a successful outcome

#### Scenario: Fact provenance and output bounds are preserved

- **WHEN** a successful action exposes a primitive result field in its explicit facts envelope
- **THEN** the fact records its verified status, source event, Function and Plugin, while unbounded, composite, malformed or undeclared output is excluded

## ADDED Requirements

### Requirement: Structured clarification state is persisted with the session

The system SHALL represent model-generated clarification requests as bounded structured state, including the clarification kind, status and finite user-selectable options when applicable. The state SHALL be data-only and SHALL NOT authorize a Function, Plugin or side effect.

#### Scenario: A model asks the user to choose an option

- **WHEN** response generation returns a valid finite clarification option set
- **THEN** the session stores the options as pending structured state and exposes the user-facing text together with that state

#### Scenario: A short selection follows a clarification

- **WHEN** the next user message is a key or short value matching a pending option
- **THEN** the model receives the current message, pending options and verified facts together, without requiring a business-specific keyword

#### Scenario: Invalid clarification metadata is returned

- **WHEN** the model returns missing, duplicated, oversized or malformed clarification options
- **THEN** the runtime rejects the metadata, preserves the previous valid state and returns a safe clarification response without authorizing an action

### Requirement: Model calls receive pending clarification as structured data

The system SHALL provide pending clarification state and relevant verified facts to semantic extraction, fallback and response-generation calls while keeping the current user message distinct. Raw historical chat messages SHALL remain excluded, and structured context SHALL be treated as untrusted data rather than instructions.

#### Scenario: A fact-based follow-up is asked

- **WHEN** a user asks for a value from a prior successful result
- **THEN** the response model receives the verified fact and can answer without repeating the original action

#### Scenario: A numeric answer selects a generic option

- **WHEN** a user sends `1` while a pending clarification contains option `1`
- **THEN** the model can resolve the selection from the structured option state and answer or continue clarification without domain-specific runtime branching

#### Scenario: Context is resumed from SQLite

- **WHEN** a session is resumed after its latest snapshot was persisted
- **THEN** verified facts and pending clarification options are available before the next model decision

