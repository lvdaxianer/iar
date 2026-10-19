# Spec Delta

## Purpose

Provide isolated, current and bounded structured context to model calls so follow-up requests use verified outcomes without replaying raw chat history or unnecessarily repeating side effects.

## ADDED Requirements

### Requirement: Each session has isolated and current structured context
The system SHALL maintain separate structured state for each session and update it from accepted events before the next decision in that session. Successful actions SHALL produce traceable facts from permitted fields of declared output contracts; failed or unconfirmed actions SHALL NOT be represented as successful facts. Session lifecycle and storage SHALL be bounded, and concurrent turns SHALL NOT observe partially updated same-session state.

#### Scenario: A successful result becomes a fact
- **WHEN** an action completes successfully with permitted result fields
- **THEN** those fields and their event provenance are available to subsequent decisions in the same session

#### Scenario: Sessions are isolated
- **WHEN** two sessions perform operations or ask follow-up questions
- **THEN** neither session receives the other session's facts or state

#### Scenario: An action is unsuccessful or awaits confirmation
- **WHEN** an action fails or has not yet been confirmed and executed
- **THEN** it is not recorded as a successful outcome

#### Scenario: Fact provenance and output bounds are preserved
- **WHEN** a successful action exposes a permitted primitive result field
- **THEN** the fact records its verified status, source event, Function and Plugin, while only fields explicitly present in the bounded `facts` output envelope are accepted and unpermitted, unbounded, object, array or sensitive output is excluded

### Requirement: Structured session state is asynchronously persisted and recoverable
The system SHALL enqueue every structured context update as an immutable, versioned session snapshot for asynchronous SQLite persistence without blocking the request event loop. Snapshots SHALL include the bounded verified facts and provenance, behavior state and validated summary needed to continue decisions. Writes SHALL preserve session order and prevent older versions replacing newer ones; errors, retries, and queue capacity SHALL be handled explicitly.

#### Scenario: Continue after restart
- **WHEN** a committed session snapshot exists and the service restarts
- **THEN** resuming the same session loads its latest valid snapshot before a new model decision, including its verified prior facts

#### Scenario: Writes arrive out of order or fail
- **WHEN** a write is delayed, fails or is retried
- **THEN** an older snapshot cannot replace a newer committed version, failure is observable, and retry and pending work remain bounded

#### Scenario: Stored state is invalid or belongs to another session
- **WHEN** a snapshot is corrupt, incompatible, or belongs to another session
- **THEN** it is not used as trusted context for the requesting session

#### Scenario: Service shutdown
- **WHEN** the service shuts down normally
- **THEN** it awaits outstanding writes; abrupt termination before a write commits may lose that update and is not represented as durable

#### Scenario: File-backed resume
- **WHEN** `IAR_SANDBOX_SQLITE_PATH` or `snapshotPath` configures a file-backed database and the client calls `POST /api/sessions/{sessionId}/resume`
- **THEN** the known session loads its latest valid snapshot before accepting its next operation; without a configured path, in-process SQLite remains suitable for tests and single-process operation

### Requirement: Model calls receive structured conversational context
The system SHALL provide role-appropriate, bounded structured state and relevant verified facts to applicable semantic extraction, decision, fallback and response-generation model calls, while keeping the current user message distinct and omitting raw historical chat messages. Context content SHALL be treated as data, not privileged instructions.

#### Scenario: A later question is processed
- **WHEN** a user sends a follow-up after an action completes
- **THEN** semantic extraction and response generation receive the current message and a structured context containing the relevant prior outcome

#### Scenario: Streaming and non-streaming responses
- **WHEN** the same follow-up is handled in streaming or non-streaming mode
- **THEN** both paths receive equivalent structured context and preserve the same safety boundaries

### Requirement: Models can answer from verified facts without repeating actions
The system SHALL enable model-based assessment of whether a request can be answered from same-session verified facts, needs clarification, or requires a new action. The fallback prompt SHALL instruct the model to answer from supported facts, clarify absent or ambiguous facts, and not invent results. The system SHALL NOT use business-specific follow-up keyword rules or automatically execute a side-effecting action merely because a request mentions a business entity.

#### Scenario: Ask for the previous ticket number
- **WHEN** a ticket was successfully created and the user asks for its number
- **THEN** the model can answer using the identifier from that successful event without invoking or confirming a second ticket creation

#### Scenario: Other business results work the same way
- **WHEN** a user asks about a prior successful result in another supported subsystem
- **THEN** the same generic fact and decision mechanism supports answering without a subsystem-specific rule

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
