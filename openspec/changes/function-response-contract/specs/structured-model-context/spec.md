# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The system SHALL include current routing scope, verified facts, pending clarification, bounded recent messages and the current user message in applicable model calls. Only Function results whose validated response mode is `model` SHALL enter response generation; `direct` and `none` results SHALL preserve their declared non-model boundaries. The current Agent's enabled and authorized capability descriptions SHALL remain bounded model context, and self-introduction responses SHALL receive the bounded capability inventory and Agent supplementary prompt.

#### Scenario: Direct result skips response generation

- **WHEN** a Function returns a valid `direct` response
- **THEN** the runtime returns its bounded text without sending the Function output to the response model

#### Scenario: UI-only result skips chat generation

- **WHEN** a Function returns a valid `none` response for confirmation or form state
- **THEN** the runtime updates the structured host state without appending a normal assistant message

#### Scenario: Self-introduction remains model-generated

- **WHEN** self-introduction returns the current capability inventory and supplementary prompt
- **THEN** the response model receives them as bounded data and composes the user-facing introduction

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
