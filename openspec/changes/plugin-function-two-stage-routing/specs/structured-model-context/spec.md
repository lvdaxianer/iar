# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The runtime SHALL provide `semantic.extract` with current user text, bounded recent messages, verified structured context, and enabled/authorized Plugin-level capability descriptions. The `function.call` stage SHALL receive the same relevant context plus only the selected Plugin's Function tools and input Schemas. Neither model call SHALL receive authority-bearing secrets or a cross-Plugin executable Function list.

#### Scenario: Plugin proposal input is bounded

- **WHEN** semantic extraction runs
- **THEN** its capability context contains Plugin IDs, descriptions and bounded action summaries, but no Function input/output Schema or execution permission

#### Scenario: Function call input is scoped

- **WHEN** Function Calling runs after Plugin selection
- **THEN** its tool set contains only current Functions owned by that Plugin and the runtime still treats the model output as untrusted data

#### Scenario: Read query result is summarized

- **WHEN** a selected read/query operation returns a valid structured result
- **THEN** the response model receives that result together with the current question, Agent prompt layers and structured context, and its validated text becomes the user-facing reply

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

### Requirement: Existing decision contracts remain authoritative

The runtime SHALL preserve the existing JEV priority and Intent Model fallback policy for the Function-call stage, while `semantic.extract` and `response.generate` use the configured normal interaction model. Missing JEV SHALL select the configured Intent Model and SHALL NOT silently select a mock provider.

#### Scenario: JEV is available

- **WHEN** a valid JEV `function.call` profile exists
- **THEN** the Function-call stage uses JEV and records its profile/backend without invoking Intent Model for the same attempt

#### Scenario: JEV is not configured

- **WHEN** no valid JEV `function.call` profile exists but the Intent Model profile is configured
- **THEN** the Function-call stage uses Intent Model through the same validated proposal boundary

#### Scenario: A decision backend selects a candidate

- **WHEN** JEV or the intent model returns a decision
- **THEN** the existing decision validation and final authorization gates still apply

### Requirement: Applicable reply models receive the Agent overall prompt

The response model SHALL continue to receive the Agent overall prompt, selected Plugin supplementary prompt and validated Function output. The Function-call model SHALL receive only the runtime Function-call contract and selected Plugin/Function data; Agent free-form prompt text SHALL not add tools, permissions or capabilities.

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
