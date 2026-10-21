# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The system SHALL include current routing scope, verified facts, pending clarification, bounded recent messages and the current user message in applicable model calls. Only Function results whose validated response mode is `model` SHALL enter response generation; read/query results SHALL enter response generation by default and SHALL not be presented as final Function text. `direct` and `none` results SHALL preserve their declared non-model boundaries. The current Agent's enabled and authorized capability descriptions SHALL be included as bounded model context for semantic extraction, fallback replies and Pi delegation. Recent messages SHALL be labeled untrusted, bounded by count and size, and non-authoritative. Self-introduction responses SHALL also receive the bounded capability inventory and Agent supplementary prompt; compaction SHALL exclude raw message history.

#### Scenario: Read query result is summarized

- **WHEN** a selected read/query operation returns a valid structured result
- **THEN** the response model receives the result together with the current question, Agent prompt layers and structured context, and its validated text becomes the user-facing reply

#### Scenario: Direct result skips response generation

- **WHEN** a Function returns a valid `direct` response under an allowed non-query exception
- **THEN** the runtime returns its bounded text without sending the Function output to the response model

#### Scenario: UI-only result skips chat generation

- **WHEN** a Function returns a valid `none` response for confirmation or form state
- **THEN** the runtime updates the structured host state without appending a normal assistant message

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

### Requirement: Applicable reply models receive the Agent overall prompt

The runtime SHALL provide the validated Agent overall prompt to IAR response generation and Pi delegation as bounded instruction context, while semantic extraction and context compaction SHALL retain their fixed structured-output protocols unless explicitly configured by a future role-specific contract. A response-model call for a Function result SHALL also receive the bounded Function output and any Function-declared supplementary presentation prompt as data.

#### Scenario: Response model receives overall prompt
- **WHEN** a `model` Function result is processed
- **THEN** the response model receives the Agent overall prompt together with the current user message, Function output and structured context

#### Scenario: Query output receives all response layers
- **WHEN** a read/query Function result is processed
- **THEN** the response model receives the runtime base response instructions, Agent overall prompt, Function supplementary prompt if declared, and validated query output in separate bounded fields

#### Scenario: Pi fallback receives overall prompt
- **WHEN** routing passes an input through to Pi Agent
- **THEN** Pi receives the Agent overall prompt together with its fixed safety boundary and current capability context

#### Scenario: Direct and none do not receive a model call
- **WHEN** a Function result declares `direct` or `none`
- **THEN** no response-model prompt is assembled for that result

### Requirement: Reply source is observable

The bridge and host-facing result SHALL identify whether the user-visible reply came from a direct Function result, IAR response generation, Pi Agent, no-reply mode, or a response model answering from verified session context, without exposing raw prompts or model payloads.

#### Scenario: Self-introduction source is response model
- **WHEN** self-introduction succeeds with `mode=model`
- **THEN** the result reports `response_model` as its reply source and includes the selected Function and Plugin identifiers in route evidence

#### Scenario: Query source is response model
- **WHEN** a read/query Function succeeds
- **THEN** the result reports `response_model` as its reply source and includes the selected Function and Plugin identifiers in route evidence

#### Scenario: Verified-context answer is distinct from clarification
- **WHEN** no Function is selected and the response model answers from a uniquely resolved verified fact
- **THEN** the result reports a context-answer disposition distinct from a response that asks the user for clarification, and does not claim that a Function or Plugin was executed

#### Scenario: Pass-through source is Pi Agent
- **WHEN** no enabled Function handles the input and Pi Agent produces the reply
- **THEN** the result reports `pi_agent` as its reply source
