# session-persistence-provider Specification

## Purpose

为 IAR 提供不绑定具体数据库的会话持久化 SPI，并以可替换 Provider 保存消息、事件和结构化上下文；SQLite 是内置默认实现，外部 Provider 通过受校验的配置和动态加载接入。

## ADDED Requirements

### Requirement: Persistence Provider is an explicit versioned SPI

The runtime SHALL depend on a versioned persistence provider interface that supports appending session messages and immutable events, saving and loading versioned snapshots, flushing accepted asynchronous work, and closing resources. The interface SHALL carry a stable `sessionId` on every session record.

#### Scenario: External provider implements the SPI

- **WHEN** an external package implements the declared provider factory and API version
- **THEN** the runtime can load and use it without changing Runtime, Hook, or model-routing code

#### Scenario: Provider receives session identity

- **WHEN** a message, event, or snapshot is persisted
- **THEN** the persistence call includes the canonical `sessionId` and does not derive it from message text or model output

### Requirement: Provider loading is explicit and validated

The host SHALL load only the configured Provider package or the built-in SQLite Provider, validate its manifest, API version, required factory export, and capability contract, and SHALL reject an unavailable or incompatible Provider before accepting session mutations.

#### Scenario: Built-in SQLite is the default

- **WHEN** no Provider is configured
- **THEN** the host selects the built-in SQLite Provider with the configured or default local path

#### Scenario: Incompatible Provider is rejected

- **WHEN** the configured package is missing, does not export the configured factory, or declares an unsupported SPI version
- **THEN** startup returns a stable Provider configuration error and does not silently fall back to an unrelated implementation

### Requirement: SQLite Provider is asynchronous and recoverable

The built-in SQLite Provider SHALL preserve event immutability, snapshot revision ordering, idempotency by stable event/message identifiers, bounded asynchronous writes, retry evidence, and graceful `flush`/`close` behavior.

#### Scenario: Older snapshot cannot overwrite newer state

- **WHEN** an older snapshot write completes after a newer revision
- **THEN** the older revision is rejected or ignored and the latest valid snapshot remains recoverable

#### Scenario: Normal shutdown drains accepted writes

- **WHEN** the host closes normally
- **THEN** the Provider drains accepted writes before closing its SQLite resources

### Requirement: Session restore is Provider-independent

The runtime SHALL restore a session by its `sessionId`, load the latest valid snapshot and relevant ordered events through the SPI, and make restored structured state available before the next model decision.

#### Scenario: Session continues after restart

- **WHEN** a client resumes a known `sessionId` after process restart
- **THEN** the runtime restores the latest valid structured context before accepting the next turn
