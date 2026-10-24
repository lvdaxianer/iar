# Pi Host Session Recovery

## Purpose

让 Pi Host 页面刷新和 SSE 重连不会破坏同一标签页的对话上下文、IAR 会话状态或待确认流程，同时为无主会话提供明确的清理边界。

## Requirements

### Requirement: Same session reconnect preserves server context

The Pi Host SHALL keep a server-side session associated with a valid session ID after an SSE client disconnects, so a later request using the same ID continues the same Pi Agent transcript and IAR bridge mapping until the session is explicitly cleared or expires.

#### Scenario: Browser refresh keeps conversational context

- **WHEN** a page sends turns, its SSE connection closes because the same tab is refreshed, and the page reconnects with the same session ID
- **THEN** the next input is processed by the existing server-side Pi Host session and can use the prior Pi Agent and IAR context without replaying or executing the previous input

#### Scenario: New browser session remains isolated

- **WHEN** another page uses a different valid session ID
- **THEN** it receives a separate Pi Host session and cannot observe the first page's Pi Agent transcript, IAR mapping, or pending action

### Requirement: Reconnect synchronizes pending confirmation state

The Pi Host SHALL expose the current pending confirmation summary to a newly connected SSE client for the same session, without exposing Action input or other sensitive model data.

#### Scenario: Refresh restores a pending confirmation card

- **WHEN** a session is awaiting confirmation and its page reconnects after refresh
- **THEN** the SSE client receives the current pending action summary and renders the confirmation state so confirmation or cancellation still targets the current IAR action

#### Scenario: No pending action clears stale UI state

- **WHEN** a session has no pending confirmation when a client reconnects
- **THEN** the SSE client receives an empty confirmation state and the page removes any stale confirmation card

### Requirement: Explicit clear creates a fresh session

The Pi Host SHALL provide an explicit session-clear operation that releases the server-side session for the requested session ID and allows the page to continue with a new session ID.

#### Scenario: User clears the session

- **WHEN** the user confirms the page's clear-session action while no turn is in flight
- **THEN** the old server-side context and pending action are released, the browser history for the old ID is removed, and subsequent input uses a new isolated session

#### Scenario: Clear does not interrupt an active turn

- **WHEN** a turn is still in flight and the user attempts to clear the session
- **THEN** the clear operation is rejected or not sent and the active request remains intact

### Requirement: Detached sessions are bounded and safely reclaimed

The Pi Host SHALL reclaim sessions that have no connected SSE clients and have exceeded the configured idle lifetime, while retaining active or recently used sessions and disposing them during server shutdown.

#### Scenario: Idle detached session expires

- **WHEN** a session has no SSE clients and remains unused beyond the idle lifetime
- **THEN** the server disposes the Pi Host session and removes it from the session index; a later request with that ID starts a new session or returns the documented unavailable response without using stale context

#### Scenario: Active session is retained

- **WHEN** a session has a connected SSE client or receives a request before the idle lifetime elapses
- **THEN** the server does not reclaim it and subsequent requests continue the same context
