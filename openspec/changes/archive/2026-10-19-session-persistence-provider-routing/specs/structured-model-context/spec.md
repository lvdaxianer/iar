# structured-model-context Delta

## MODIFIED Requirements

### Requirement: Structured session state is asynchronously persisted and recoverable

The system SHALL enqueue every accepted message and structured context update through the configured Persistence Provider, using `sessionId` as the stable association key and preserving bounded verified facts, routing scope, pending clarification, behavior state, and validated summary. The default SQLite Provider SHALL be replaceable without changing model-call code.

#### Scenario: Continue after restart

- **WHEN** a committed session snapshot exists and the service restarts
- **THEN** resuming the same session loads its latest valid snapshot before a new model decision, including its verified prior facts

#### Scenario: External Provider restores the same context

- **WHEN** an external persistence Provider stores and later loads a session snapshot
- **THEN** the next model decision receives the same validated structured context as the built-in SQLite Provider

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

The system SHALL include the current routing scope, relevant verified facts, pending clarification, and current user message in applicable model calls while excluding raw historical chat messages from the model decision payload.

#### Scenario: A later question is processed

- **WHEN** a user sends a follow-up after an action completes
- **THEN** semantic extraction and response generation receive the current message and the current routing scope and verified facts

#### Scenario: A numeric answer selects a generic option

- **WHEN** a user sends `1` while a pending clarification contains option `1`
- **THEN** the model can resolve the selection from the structured option state without domain-specific runtime branching

#### Scenario: Streaming and non-streaming responses

- **WHEN** the same follow-up is handled in streaming or non-streaming mode
- **THEN** both paths receive equivalent structured context and preserve the same safety boundaries
