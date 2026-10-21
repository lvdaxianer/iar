# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The system SHALL include current routing scope, verified facts, pending clarification, bounded recent messages and the current user message in applicable model calls. The current Agent's enabled and authorized capability descriptions SHALL be included as bounded model context for semantic extraction, fallback replies and Pi delegation. Self-introduction responses SHALL also receive the bounded capability inventory and Agent supplementary prompt; compaction SHALL exclude raw message history.

#### Scenario: A later question is processed

- **WHEN** a user sends a follow-up after an action completes
- **THEN** semantic extraction and response generation receive the current message, the bounded recent-message window and structured context containing the relevant prior outcome

#### Scenario: Enabled capability descriptions are baseline context

- **WHEN** any model call handles an Agent input
- **THEN** it receives only the current Agent's enabled and authorized capability descriptions as bounded context, whether or not a Function is selected for the current input

#### Scenario: Disabled capability descriptions are absent

- **WHEN** an Agent Plugin is disabled before a model call
- **THEN** its Function and Plugin descriptions are absent from semantic candidates, fallback context, Pi context and self-introduction inventory

#### Scenario: Raw history cannot authorize an action

- **WHEN** recent raw messages contain an earlier request or an assistant statement describing an action
- **THEN** the runtime still requires a current validated semantic choice, registry authorization, policy evaluation and confirmation before executing a side effect

#### Scenario: Streaming and non-streaming responses

- **WHEN** the same follow-up is handled in streaming or non-streaming mode
- **THEN** both paths receive equivalent recent-message and structured-context inputs and preserve the same safety boundaries

#### Scenario: Self-introduction result is model data only

- **WHEN** the self-introduction Plugin returns the current capability inventory and supplementary prompt
- **THEN** the response model can use them to compose the final introduction, but the fields cannot add a Plugin, bypass routing, or authorize execution

#### Scenario: Compaction excludes raw messages

- **WHEN** the system requests context compaction
- **THEN** the compaction model receives structured state and relevant events but no recent-message window
