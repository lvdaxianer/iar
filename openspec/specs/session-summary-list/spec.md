# session-summary-list Specification

## Purpose

为客户端提供轻量、可分页、仅用于展示和恢复选择的持久化会话摘要列表，并确保查询边界、展示安全性及重启恢复行为可被契约验证。

## Requirements

### Requirement: Persistence Provider lists bounded session summaries

The Persistence Provider SHALL expose a bounded, deterministic, paginated session-summary query. Each item SHALL contain a stable opaque `sessionId` and an optional summary string, and SHALL NOT contain full messages, events, BehaviorContext or trusted facts.

#### Scenario: List a page of sessions

- **WHEN** a caller requests a valid page size
- **THEN** the Provider returns no more than that number of session summaries and an opaque cursor when more records remain

#### Scenario: Continue with a cursor

- **WHEN** a caller submits a cursor returned by the previous page
- **THEN** the Provider returns the next deterministic page without repeating or skipping a session

#### Scenario: Empty persistence returns an empty page

- **WHEN** the Provider contains no persisted session records
- **THEN** it returns an empty session array without inventing a session

### Requirement: Summary source is generic and bounded

The SQLite Provider SHALL prefer a non-empty structured context summary for display and SHALL fall back to a bounded first user message when no structured summary exists. Summary text SHALL remain display-only and SHALL NOT become trusted behavior state.

#### Scenario: Structured summary takes precedence

- **WHEN** a session snapshot contains a non-empty `context.summary.text`
- **THEN** the session list exposes that text as the summary

#### Scenario: First user message is the fallback

- **WHEN** a session has no structured summary but has a persisted user message
- **THEN** the session list exposes a bounded copy of the first user message as the summary

#### Scenario: Summary does not authorize behavior

- **WHEN** a summary contains text resembling a route, fact or action
- **THEN** the runtime does not use it for routing, confirmation, fact projection or execution

### Requirement: Session summaries survive provider restart

The SQLite Provider SHALL preserve its summary index across close and reopen, while continuing to use the existing event and snapshot stores as recovery sources of truth.

#### Scenario: Restart preserves summaries

- **WHEN** a Provider is closed and reopened against the same database
- **THEN** previously indexed session summaries remain available with the same session IDs and order

#### Scenario: Existing records are indexed without rewriting payloads

- **WHEN** the Provider starts against an existing database containing messages, events or snapshots
- **THEN** the summary index is available without changing the original payload records

### Requirement: HTTP session listing is safe and paginated

The sandbox SHALL expose `GET /api/sessions` with bounded `limit` and opaque `cursor` parameters, returning only session summaries. Invalid pagination input SHALL return a stable client error, and absence of a Persistence Provider SHALL remain compatible with in-memory operation.

#### Scenario: HTTP lists persisted summaries

- **WHEN** a client requests `GET /api/sessions`
- **THEN** the response contains a bounded `sessions` array and an optional `nextCursor`

#### Scenario: HTTP rejects invalid pagination

- **WHEN** a client submits a non-finite, negative or oversized limit or malformed cursor
- **THEN** the endpoint returns a stable 400 response without querying an unbounded history

#### Scenario: HTTP without persistence remains usable

- **WHEN** the sandbox runs without a Persistence Provider
- **THEN** `GET /api/sessions` returns an empty list and existing session lifecycle routes keep their behavior
