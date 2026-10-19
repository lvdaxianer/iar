# Design

## Architecture

IAR Core depends on a versioned `@iar/persistence-spi` contract. A `PersistenceProviderRegistry` resolves either the built-in SQLite Provider or an explicitly configured external package factory. Runtime and Hook code receive the provider through dependency injection; no business module imports SQLite or scans `node_modules`.

The session identity is created by the session host and carried on every message, event, snapshot and Hook payload. `sessionId` is the stable conversation aggregate key, while `runId` identifies a workflow execution and `traceId` identifies one request/model chain. The default SQLite adapter uses a dedicated asynchronous SQLite worker for messages, events and snapshots, with bounded queueing, revision checks and idempotency checks; the existing storage adapters remain compatible for legacy consumers.

Routing stores a bounded `routingScope` in BehaviorContext. The first decision sees only a small Plugin summary catalog when no scope exists. Once a Plugin is selected, the runtime expands Function candidates inside that Plugin and applies fixed `actionTypes`; the final Function decision remains advisory and all existing authorization, policy, capability and confirmation checks remain authoritative.

## Event and Hook Flow

The Runtime emits `message.received`, `context.updated`, `message.sent`, `context.compacted`, `action.completed` and `action.failed` with a common session identity. A persistence subscription asynchronously calls the injected Provider. Synchronous before Hooks remain reserved for blocking policy/confirmation decisions; persistence and observation use bounded asynchronous StateEvent delivery with idempotency, retries, fail-open observer behavior, and explicit shutdown draining.

## Provider Loading

The composition root reads `persistence.provider` and `persistence.options`. `sqlite` resolves the built-in provider. Any other provider value is dynamically imported as an installed package, and the host validates the manifest, `iar.persistence/v1`, factory export, and required methods before installing it. Provider configuration errors fail startup rather than silently falling back to a different data store.

## Compatibility

Existing `SnapshotStore` consumers remain supported through an adapter. Existing legacy Sandbox sessions continue to use the compatibility `legacy` session, while new session routes use the generated `sessionId`. Older snapshots that only have `runId` are accepted through an explicit compatibility mapping and are not mixed across session IDs.

## Failure and Recovery

The provider queue is bounded. Accepted writes are retried by the provider/dispatcher and drained on normal shutdown. A failed snapshot never replaces the last valid snapshot; a corrupt or mismatched snapshot is rejected before model calls. Abrupt process termination may lose an uncommitted asynchronous update and is reported as non-durable, matching the existing structured-context contract.

## Testing Strategy

Contract tests cover Provider loading, SPI validation, session identity propagation, SQLite idempotency/revision ordering, external in-memory Provider substitution, and graceful drain. Routing tests cover Plugin-first narrowing, action filtering inside scope, scope reuse/replacement, and no-global-query fan-out. Integration tests cover messages and context snapshots across restart, short clarification replies, streaming/non-streaming parity, and existing JEV/Intent Model behavior.
