# structured-model-context Specification

## Purpose

Provide isolated, current and bounded structured context to model calls so follow-up requests use verified outcomes without replaying raw chat history or unnecessarily repeating side effects.

## Requirements

### Requirement: Each session has isolated and current structured context

The system SHALL maintain separate structured state for each session and update it from accepted events before the next decision in that session. Successful actions SHALL produce traceable facts only from the plugin's explicitly declared, bounded fact envelope; failed or unconfirmed actions SHALL NOT be represented as successful facts. Session lifecycle and storage SHALL be bounded, and concurrent turns SHALL NOT observe partially updated same-session state.

#### Scenario: A successful result becomes a fact

- **WHEN** an action completes successfully and its plugin explicitly exposes bounded primitive facts
- **THEN** those fields and their event provenance are available to subsequent decisions in the same session

#### Scenario: Sessions are isolated

- **WHEN** two sessions perform operations or ask follow-up questions
- **THEN** neither session receives the other session's facts or state

#### Scenario: An action is unsuccessful or awaits confirmation

- **WHEN** an action fails or has not yet been confirmed and executed
- **THEN** it is not recorded as a successful outcome

#### Scenario: Fact provenance and output bounds are preserved

- **WHEN** a successful action exposes a primitive result field in its explicit facts envelope
- **THEN** the fact records its verified status, source event, Function and Plugin, while only fields explicitly present in the bounded `facts` output envelope are accepted and unpermitted, unbounded, object, array or sensitive output is excluded

### Requirement: Structured clarification state is persisted with the session

The system SHALL persist model-generated clarification state with a bounded kind, status and finite options when applicable. Options SHALL come from current runtime-filtered candidate descriptors. Clarification state SHALL remain data-only and SHALL NOT authorize a Function, Plugin or side effect.

#### Scenario: A model asks the user to choose an option

- **WHEN** response generation requires a user choice and the runtime has a finite authorized candidate set
- **THEN** the session stores bounded options derived from that candidate set and exposes the user-facing text together with the pending state

#### Scenario: A short selection follows a clarification

- **WHEN** the next user message is a key or short value matching a pending option
- **THEN** the runtime validates the option against the current candidate set and the model receives the current message, pending options and verified facts without requiring a business-specific keyword

#### Scenario: Invalid clarification metadata is returned

- **WHEN** the model returns missing, duplicated, oversized or malformed clarification options
- **THEN** the runtime rejects the metadata, preserves the previous valid state and returns a safe clarification response without authorizing an action

### Requirement: Structured session state is asynchronously persisted and recoverable

The system SHALL persist accepted messages and structured context through the configured Persistence Provider using `sessionId` as the stable key. Snapshots SHALL preserve bounded facts, routing scope, pending clarification, behavior state and validated summary. Persistence SHALL be asynchronous, ordered, bounded and revision-safe.

#### Scenario: Continue after restart

- **WHEN** a committed session snapshot exists and the service restarts
- **THEN** resuming the same session loads its latest valid snapshot before a new model decision, including its verified prior facts and pending clarification state

#### Scenario: External Provider restores the same context

- **WHEN** an external persistence Provider stores and later loads a session snapshot
- **THEN** the next model decision receives the same validated structured context as the built-in SQLite Provider

#### Scenario: Recent messages are restored after restart

- **WHEN** a session has accepted message records and is resumed with a configured recent-message limit
- **THEN** the runtime loads at most that many latest ordered messages into the model input window without copying them into trusted BehaviorContext facts

#### Scenario: Writes arrive out of order or fail

- **WHEN** a write is delayed, fails or is retried
- **THEN** an older snapshot cannot replace a newer committed version, failure is observable, and retry and pending work remain bounded

#### Scenario: Stored state is invalid or belongs to another session

- **WHEN** a snapshot, message record or clarification state is corrupt, incompatible, or belongs to another session
- **THEN** it is not used as trusted context for the requesting session

#### Scenario: Service shutdown

- **WHEN** the service shuts down normally
- **THEN** it awaits outstanding message and snapshot writes; abrupt termination before a write commits may lose that update and is not represented as durable

#### Scenario: File-backed resume

- **WHEN** `IAR_SANDBOX_SQLITE_PATH` or `snapshotPath` configures a file-backed database and the client calls `POST /api/sessions/{sessionId}/resume`
- **THEN** the known session loads its latest valid snapshot and bounded recent-message window before accepting its next operation; without a configured path, in-process SQLite remains suitable for tests and single-process operation

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

### Requirement: Model calls receive pending clarification as structured data

The system SHALL provide pending clarification state, runtime-filtered candidate options, relevant verified facts, bounded recent messages and the distinct current user message to semantic extraction, fallback and response-generation calls. The model SHALL treat all context fields as data rather than privileged instructions, and raw historical messages SHALL remain bounded and non-authoritative.

#### Scenario: A fact-based follow-up is asked

- **WHEN** a user asks for a value from a prior successful result
- **THEN** the response model receives the verified fact and relevant recent messages and can answer without repeating the original action

#### Scenario: A numeric answer selects a generic option

- **WHEN** a user sends a key or short value matching a pending runtime-generated option
- **THEN** the model can resolve the selection from structured option state without domain-specific runtime branching

#### Scenario: Context is resumed from SQLite

- **WHEN** a session is resumed after its latest snapshot and messages were persisted
- **THEN** verified facts, pending clarification options and the bounded recent-message window are available before the next model decision

### Requirement: Models can answer from verified facts without repeating actions

The system SHALL separate semantic intent from a fixed action type and give the model only finite, runtime-filtered Plugin/Function candidates. The action type SHALL be one of `query`, `create`, `update`, `delete`, `transfer`, `execute` or `unknown`, never a business-specific operation. When no Function is selected, the response model SHALL answer from verified facts or ask a bounded clarification and SHALL NOT execute a Function.

#### Scenario: Ask for the previous ticket number

- **WHEN** a ticket was successfully created and the user asks for its number
- **THEN** the model can answer using the identifier from that successful event without invoking or confirming a second ticket creation

#### Scenario: Other business results work the same way

- **WHEN** a user asks about a prior successful result in another supported subsystem
- **THEN** the same generic fact and decision mechanism supports answering without a subsystem-specific rule

#### Scenario: A query action is separated from semantic intent

- **WHEN** the user asks for a fact, result, status, progress, count, position or identifier, including a reference to a verified prior result
- **THEN** semantic extraction uses `action=query` or `action=unknown` and does not authorize a side-effecting operation from the historical reference

#### Scenario: Candidate capabilities are filtered before model selection

- **WHEN** a semantic action is available for the current message
- **THEN** the runtime filters candidates by session scope, lifecycle, authorization and declared action types before giving bounded Plugin/Function descriptions to the decision model

#### Scenario: No suitable Function is available

- **WHEN** candidates are absent, incompatible, uncertain or rejected
- **THEN** the runtime skips action preparation and execution and gives the current question, structured context, verified facts and pending state to the response model, which either answers or asks for clarification

#### Scenario: Insufficient or ambiguous evidence

- **WHEN** available facts do not establish the intended result or contain the requested value
- **THEN** the model is instructed to express uncertainty or ask for clarification instead of inventing a value or initiating a side effect

#### Scenario: A genuinely new operation is requested

- **WHEN** a supported new operation is selected
- **THEN** existing authorization, policy and confirmation checks remain in force

### Requirement: Compaction preserves trusted facts

The system SHALL use validated successful compaction results while retaining trusted action facts and event provenance within documented bounds. Generated summaries SHALL NOT turn unverified claims into trusted facts. Failed or invalid compaction SHALL preserve the last valid snapshot, and omitted facts SHALL NOT be presented as complete.

#### Scenario: A ticket result survives compaction

- **WHEN** a successful ticket creation is followed by successful or failed compaction and a follow-up query
- **THEN** the original verified ticket identifier remains available and no new action is executed

#### Scenario: Raw conversation history is excluded from compaction

- **WHEN** a compaction request contains a bounded structured context and immutable events
- **THEN** the compaction model receives no recent-message history and trusted facts remain sourced from the existing context and events

#### Scenario: Compaction exceeds a documented bound

- **WHEN** a summary or event window exceeds its configured capacity, or the model returns an invalid/truncated result
- **THEN** the runtime rejects the candidate, records the failure path, and preserves the previous valid context without skipping events

#### Scenario: Compression model inputs are structured

- **WHEN** the system requests compaction
- **THEN** it supplies structured state and relevant events without including raw conversation history

### Requirement: Existing decision contracts remain authoritative

The system SHALL preserve JEV priority, the shared validated decision result, finite candidates, authorization and policy checks when structured context is introduced. Missing, invalid or uncertain decisions SHALL NOT silently authorize a side-effecting action.

#### Scenario: A decision backend selects a candidate

- **WHEN** JEV or the intent model returns a decision
- **THEN** the existing decision validation and final authorization gates still apply

### Requirement: Model transport is safely observable

The sandbox SHALL correlate inbound requests and model HTTP calls using bounded, safe metadata, provide a controlled runtime debug switch, and avoid recording credentials, raw prompts, responses, or untrusted error text.

#### Scenario: Model HTTP call succeeds or fails

- **WHEN** a normal or streaming model call succeeds, fails, times out, or exceeds its slow-call threshold
- **THEN** the appropriate DEBUG or WARN record includes correlation and timing metadata without exposing sensitive content

#### Scenario: Debug logging is enabled at runtime

- **WHEN** an authorized operator changes the debug setting while the sandbox is running
- **THEN** subsequent diagnostic records honor the new setting without a restart and retain the same privacy limits

### Requirement: Verified facts are retained as an ordered bounded history

The system SHALL append each accepted verified fact result as a distinct bounded record with an opaque record ID, sequence position, source event, dynamic Function/Plugin identifiers and declared values, without replacing an earlier record that shares a field key.

#### Scenario: Repeated results remain addressable

- **WHEN** two successful actions expose the same declared field key in one session
- **THEN** both verified records remain available in chronological order with distinct record IDs

#### Scenario: Failed result is not appended as trusted history

- **WHEN** an action fails, is rejected, or is not confirmed
- **THEN** no successful verified fact record is appended for that outcome

#### Scenario: Duplicate event replay is idempotent

- **WHEN** the same accepted source event is projected more than once
- **THEN** the projection retains one corresponding fact record rather than appending a duplicate

### Requirement: Historical references use a generic relation contract

The system SHALL allow the semantic model to express a historical reference using an existing opaque record ID, a finite relation, and an optional scope; the model output SHALL not contain a business-specific lookup rule or authorize an action.

#### Scenario: Previous record is requested

- **WHEN** the current message means “this result's previous one” and a current focus record exists
- **THEN** the semantic result contains the focus record ID and the generic `previous` relation

#### Scenario: Model cannot invent a target record

- **WHEN** the semantic model returns a record ID that is not present in the session history
- **THEN** the runtime rejects the reference and does not use the invented ID as a fact or execution input

#### Scenario: Relation does not authorize side effects

- **WHEN** a valid historical relation resolves to a prior record
- **THEN** the runtime may answer or prepare a read-only interpretation, but it still requires the normal route, policy and confirmation gates for any side effect

### Requirement: Ambiguous historical references are supplied as bounded model data

The system SHALL provide pending generic reference metadata and its bounded verified candidate records to semantic extraction and response generation, while keeping recent raw messages separate and non-authoritative.

#### Scenario: Ambiguity is clarified without a side effect

- **WHEN** the runtime cannot select one historical record
- **THEN** the model receives the candidate records and current message, and the runtime does not prepare or execute a Function

### Requirement: Unresolved historical references receive bounded dynamic clarification

The system SHALL fail closed when a historical reference has no valid anchor, no target, or multiple valid interpretations, and SHALL generate bounded clarification options from current runtime data or Plugin descriptors without hardcoded business choices.

#### Scenario: No anchor is available

- **WHEN** the user says “上一个” but no focus or valid anchor record exists
- **THEN** the runtime asks for a bounded clarification and does not execute an action

#### Scenario: Multiple records are plausible

- **WHEN** the relation cannot identify one target record deterministically
- **THEN** the runtime presents runtime-generated choices or asks the user to restate the reference, without selecting a business-specific default

#### Scenario: Repeated unresolved input reaches the fallback threshold

- **WHEN** unresolved reference attempts reach the configured bounded threshold
- **THEN** the runtime offers a dynamic function/plugin selection or safe retry response and resets or preserves state according to the configured escalation result

### Requirement: Unresolved routing escalates to dynamic selection

The runtime SHALL track consecutive unresolved semantic, routing or input-clarification outcomes with a bounded configurable threshold. When the threshold is reached, it SHALL present finite options collected from currently enabled and authorized Plugin descriptors instead of repeating an unbounded generic clarification.

#### Scenario: First unresolved outcome remains a normal clarification

- **WHEN** the current message has no reliable Function or required input
- **THEN** the runtime increments the unresolved streak and returns a bounded clarification without executing a Plugin

#### Scenario: Repeated unresolved outcome opens dynamic selection

- **WHEN** consecutive unresolved outcomes reach the configured threshold and finite authorized candidates exist
- **THEN** the runtime creates a selection clarification from those candidate descriptors and does not start an action workflow

#### Scenario: Successful progress resets the streak

- **WHEN** a valid route reaches confirmation or completes successfully
- **THEN** the runtime resets the unresolved streak and preserves the normal confirmation and execution boundaries

#### Scenario: No candidate is available for escalation

- **WHEN** the unresolved threshold is reached but no enabled, authorized and compatible candidate exists
- **THEN** the runtime returns a safe explanation and does not fabricate a Function, Plugin or option
