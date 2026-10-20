# session-persistence-provider Specification

## Purpose

为 IAR 提供不绑定具体数据库的会话持久化 SPI，并以可替换 Provider 保存消息、事件和结构化上下文；SQLite 是内置默认实现，外部 Provider 通过受校验的配置和动态加载接入。

## Requirements

### Requirement: Persistence Provider is an explicit versioned SPI

The runtime SHALL depend on a versioned persistence provider interface that supports appending session messages and immutable events, bounded ordered message-window reads, bounded paginated session-summary reads, saving and loading versioned snapshots, flushing accepted asynchronous work, and closing resources. The interface SHALL carry a stable `sessionId` on every session record, and session-summary reads SHALL return only opaque session IDs with optional bounded display summaries.

#### Scenario: External provider implements the SPI

- **WHEN** an external package implements the declared provider factory and API version
- **THEN** the runtime can load and use it without changing Runtime, Hook, or model-routing code

#### Scenario: Provider receives session identity

- **WHEN** a message, event, snapshot, session-summary query, or recent-message query is persisted or read
- **THEN** the persistence call includes the canonical `sessionId` and does not derive it from message text or model output

#### Scenario: Provider returns a bounded ordered window

- **WHEN** the runtime requests the latest N messages for a session
- **THEN** the Provider returns no more than N valid messages in deterministic chronological order

#### Scenario: External provider implements session listing

- **WHEN** an external package implements the declared Provider SPI
- **THEN** the runtime can request a bounded session-summary page without changing model-routing code

#### Scenario: Provider returns a bounded session-summary page

- **WHEN** the runtime requests a bounded session-summary page
- **THEN** the Provider returns no more than the requested bound in deterministic order and excludes full messages, events, structured context and trusted facts

### Requirement: Provider loading is explicit and validated

The host SHALL load only the configured Provider package or the built-in SQLite Provider, validate its manifest, API version, required factory export, and capability contract, and SHALL reject an unavailable or incompatible Provider before accepting session mutations.

#### Scenario: Built-in SQLite is the default

- **WHEN** no Provider is configured
- **THEN** the host selects the built-in SQLite Provider with the configured or default local path

#### Scenario: Incompatible Provider is rejected

- **WHEN** the configured package is missing, does not export the configured factory, or declares an unsupported SPI version
- **THEN** startup returns a stable Provider configuration error and does not silently fall back to an unrelated implementation

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

### Requirement: Providers persist the ordered verified fact history

The persistence SPI and built-in SQLite Provider SHALL save and restore the versioned bounded fact history, source provenance, sequence order and current focus together with the session snapshot, while preserving snapshot revision ordering and event idempotency.

#### Scenario: Restart restores repeated results

- **WHEN** a session with multiple verified records is resumed after process restart
- **THEN** the latest valid snapshot restores every retained record in the same order and does not collapse equal field keys

#### Scenario: Older snapshot cannot erase newer records

- **WHEN** an older snapshot write completes after a newer snapshot containing additional fact records
- **THEN** the older write is rejected or ignored and the newer fact history remains recoverable

#### Scenario: External Provider receives the same contract

- **WHEN** an external Provider implements the declared versioned SPI
- **THEN** it receives and returns the same opaque record IDs, order, provenance and focus semantics without runtime business-specific handling

### Requirement: Recent raw messages remain separate from trusted history

Persistence SHALL store recent message records independently from structured fact records and SHALL restore them only as a bounded, chronological, non-authoritative model input window.

#### Scenario: Resume loads both context sources

- **WHEN** a known session is resumed with a configured recent-message limit
- **THEN** the runtime loads the latest bounded messages alongside the ordered fact history without copying message text into trusted records

#### Scenario: Corrupt message data does not corrupt facts

- **WHEN** a restored message record is invalid or belongs to another session but the structured snapshot is valid
- **THEN** the runtime excludes that message data while preserving the valid fact history and safe session state

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
