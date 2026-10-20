# Spec Delta

## MODIFIED Requirements

### Requirement: Persistence Provider is an explicit versioned SPI

The runtime SHALL depend on a versioned persistence provider interface that supports appending session messages and immutable events, bounded ordered message-window reads, bounded paginated session-summary reads, saving and loading versioned snapshots, flushing accepted asynchronous work, and closing resources. The interface SHALL carry a stable `sessionId` on every session record, and session-summary reads SHALL return only opaque session IDs with optional bounded display summaries.

#### Scenario: External provider implements the SPI

- **WHEN** an external package implements the declared provider factory and API version
- **THEN** the runtime can load and use it without changing Runtime, Hook, or model-routing code

#### Scenario: Provider receives session identity

- **WHEN** a message, event, snapshot, session-summary query, or recent-message query is persisted or read
- **THEN** the persistence call includes the canonical `sessionId` and does not derive it from message text or model output

#### Scenario: Provider returns a bounded ordered window

- **WHEN** the runtime requests the latest N messages or a bounded session-summary page
- **THEN** the Provider returns no more than the requested bound in deterministic order

#### Scenario: External provider implements session listing

- **WHEN** an external package implements the declared Provider SPI
- **THEN** the runtime can request a bounded session-summary page without changing model-routing code

#### Scenario: Provider returns a bounded session-summary page

- **WHEN** the runtime requests a bounded session-summary page
- **THEN** the Provider returns no more than the requested bound in deterministic order and excludes full messages, events, structured context and trusted facts

### Requirement: SQLite Provider is asynchronous and recoverable

The built-in SQLite Provider SHALL preserve event immutability, snapshot revision ordering, idempotency by stable event/message identifiers, bounded asynchronous writes and reads, retry evidence, graceful `flush`/`close` behavior, and a recoverable lightweight session-summary index.

#### Scenario: Older snapshot cannot overwrite newer state

- **WHEN** an older snapshot write completes after a newer revision
- **THEN** the older revision is rejected or ignored and the latest valid snapshot remains recoverable

#### Scenario: Bounded recent-message read uses the message store

- **WHEN** the runtime requests the latest N messages for a file-backed SQLite session
- **THEN** SQLite reads the existing message records with a bounded query, preserves chronological order, and does not duplicate raw messages into the structured snapshot

#### Scenario: Normal shutdown drains accepted writes

- **WHEN** the host closes normally
- **THEN** the Provider drains accepted writes before closing its SQLite resources

#### Scenario: Summary index follows accepted writes

- **WHEN** a message, event or snapshot is accepted
- **THEN** the corresponding session is discoverable through the bounded summary query without changing the original payload tables
