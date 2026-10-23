# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The semantic extraction call SHALL receive a bounded workflow context and transition map derived from the current validated session state in addition to its existing user text, recent messages, BehaviorContext and authorized Plugin descriptors. The workflow context SHALL be advisory input for event classification only; Runtime remains the authority for target, permission, policy, confirmation and execution.

#### Scenario: Workflow context is included in semantic extraction

- **WHEN** a user supplies a continuation or parameter answer
- **THEN** semantic.extract receives the current workflow state, allowed events, pending/collection summary and authorized candidates without receiving execution secrets or unrelated capabilities

#### Scenario: Plugin proposal input is bounded

- **WHEN** semantic extraction runs
- **THEN** its capability context contains Plugin IDs, descriptions and bounded action summaries, but no Function input/output Schema or execution permission

#### Scenario: Function call input is scoped

- **WHEN** Function Calling runs after Plugin selection
- **THEN** its tool set contains only current Functions owned by that Plugin and the runtime still treats the model output as untrusted data

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
- **THEN** raw messages are not treated as verified facts or executable workflow authority

#### Scenario: Response text cannot authorize execution

- **WHEN** a response model produces text claiming that a Function is confirmed or executed
- **THEN** the runtime ignores that text for workflow transitions and requires the validated event, route, policy and confirmation path
