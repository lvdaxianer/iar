# Spec Delta

## MODIFIED Requirements

### Requirement: Model calls receive structured conversational context

The system SHALL include the current routing scope, relevant verified facts, pending clarification, bounded recent messages and current user message in applicable semantic extraction, decision, fallback and response-generation model calls. Recent messages SHALL be labeled as untrusted data, SHALL be bounded by count and size, and SHALL NOT grant authority. When the selected Function is self-introduction, response generation SHALL additionally receive the Plugin-produced bounded capability inventory and Agent-level supplementary prompt; compaction SHALL continue to exclude raw message history.

#### Scenario: A later question is processed

- **WHEN** a user sends a follow-up after an action completes
- **THEN** semantic extraction and response generation receive the current message, the bounded recent-message window and structured context containing the relevant prior outcome

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
