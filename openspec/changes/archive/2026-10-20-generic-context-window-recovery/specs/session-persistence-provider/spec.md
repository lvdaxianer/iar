# Spec Delta

## MODIFIED Requirements

### Requirement: Persistence Provider is an explicit versioned SPI
The runtime SHALL depend on a versioned persistence provider interface that supports appending session messages and immutable events, bounded ordered message-window reads, saving and loading versioned snapshots, flushing accepted asynchronous work, and closing resources. The interface SHALL carry a stable `sessionId` on every session record.

#### Scenario: External provider implements the SPI
- **WHEN** an external package implements the declared provider factory and API version
- **THEN** the runtime can load and use it without changing Runtime, Hook, or model-routing code

#### Scenario: Provider receives session identity
- **WHEN** a message, event, snapshot, or recent-message query is persisted or read
- **THEN** the persistence call includes the canonical `sessionId` and does not derive it from message text or model output

#### Scenario: Provider returns a bounded ordered window
- **WHEN** the runtime requests the latest N messages for a session
- **THEN** the Provider returns no more than N valid messages in deterministic chronological order

### Requirement: SQLite Provider is asynchronous and recoverable
The built-in SQLite Provider SHALL preserve event immutability, snapshot revision ordering, idempotency by stable event/message identifiers, bounded asynchronous writes and reads, retry evidence, and graceful `flush`/`close` behavior.

#### Scenario: Older snapshot cannot overwrite newer state
- **WHEN** an older snapshot write completes after a newer revision
- **THEN** the older revision is rejected or ignored and the latest valid snapshot remains recoverable

#### Scenario: Bounded recent-message read uses the message store
- **WHEN** the runtime requests the latest N messages for a file-backed SQLite session
- **THEN** SQLite reads the existing message records with a bounded query, preserves chronological order, and does not duplicate raw messages into the structured snapshot

#### Scenario: Normal shutdown drains accepted writes
- **WHEN** the host closes normally
- **THEN** the Provider drains accepted writes before closing its SQLite resources

### Requirement: Session restore is Provider-independent
The runtime SHALL restore a session by its `sessionId`, load the latest valid snapshot and relevant ordered events through the SPI, load the configured bounded recent-message window, and make restored structured state and message context available before the next model decision.

#### Scenario: Session continues after restart
- **WHEN** a client resumes a known `sessionId` after process restart
- **THEN** the runtime restores the latest valid structured context and bounded recent-message window before accepting the next turn

#### Scenario: Provider without recent messages fails safe
- **WHEN** a configured Provider cannot return a valid recent-message window but returns a valid structured snapshot
- **THEN** the runtime preserves the trusted structured snapshot, uses an empty bounded message window, records a stable restore outcome, and does not block the session with untrusted data

#### Scenario: Message-window data is not trusted state
- **WHEN** a restored message contains text resembling a route, capability, confirmation or execution result
- **THEN** the runtime exposes it only as bounded model input and does not treat it as a verified fact or authorization state
