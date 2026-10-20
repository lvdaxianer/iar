# Spec Delta

## MODIFIED Requirements

### Requirement: Structured clarification state is persisted with the session
The system SHALL represent model-generated clarification requests as bounded structured state, including the clarification kind, status and finite user-selectable options when applicable. Options SHALL be derived from the current runtime-filtered candidate descriptors, and clarification state SHALL remain data-only and SHALL NOT authorize a Function, Plugin or side effect.

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
The system SHALL persist each accepted message and structured context update through the configured Persistence Provider using `sessionId` as the stable key. Snapshots SHALL preserve bounded verified facts, routing scope, pending clarification, unresolved clarification state, behavior state and validated summary. The default SQLite Provider SHALL be replaceable without changing model-call code; persistence SHALL be asynchronous, ordered, bounded and revision-safe, with explicit error and retry handling.

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
- **THEN** it is not used as trusted context for the requesting session and the runtime follows its safe restore failure behavior

#### Scenario: Service shutdown
- **WHEN** the service shuts down normally
- **THEN** it awaits outstanding message and snapshot writes; abrupt termination before a write commits may lose that update and is not represented as durable

#### Scenario: File-backed resume
- **WHEN** file-backed persistence configures a database and the client resumes a known session
- **THEN** the known session loads its latest valid snapshot and bounded recent-message window before accepting its next operation

### Requirement: Model calls receive structured conversational context
The system SHALL include the current routing scope, relevant verified facts, pending clarification, bounded recent messages and current user message in applicable semantic extraction, decision, fallback and response-generation model calls. Recent messages SHALL be labeled as untrusted data, SHALL be bounded by count and size, and SHALL NOT grant authority. Compaction SHALL continue to exclude raw message history.

#### Scenario: A later question is processed
- **WHEN** a user sends a follow-up after an action completes
- **THEN** semantic extraction and response generation receive the current message, the bounded recent-message window and structured context containing the relevant prior outcome

#### Scenario: Raw history cannot authorize an action
- **WHEN** recent raw messages contain an earlier request or an assistant statement describing an action
- **THEN** the runtime still requires a current validated semantic choice, registry authorization, policy evaluation and confirmation before executing a side effect

#### Scenario: Streaming and non-streaming responses
- **WHEN** the same follow-up is handled in streaming or non-streaming mode
- **THEN** both paths receive equivalent recent-message and structured-context inputs and preserve the same safety boundaries

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

## ADDED Requirements

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
