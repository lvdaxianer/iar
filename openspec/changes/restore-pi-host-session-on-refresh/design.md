# Design

## Context

See `proposal.md` for the user-visible problem. The Pi Host page already
keeps a stable per-tab session ID in `sessionStorage` and replays bounded
display history from `localStorage`. The server currently stores
`PiHostSession` instances in a map, but removes and disposes the instance as
soon as the last SSE connection closes. `PiHostSession` owns the Pi Agent
delegate and the Pi-to-IAR bridge lifecycle, so this cleanup destroys the
actual model context while the browser still displays its replayed history.

## Goals / Non-Goals

**Goals:**

- Decouple SSE connection lifetime from Pi Host session lifetime.
- Keep same-ID reconnects on the same in-memory Pi Host session until an
  explicit clear or bounded idle expiry.
- Synchronize the current pending confirmation state to every newly connected
  SSE client without exposing Action input.
- Provide deterministic cleanup for explicit clear, idle expiry and server
  shutdown.
- Keep existing client-side history replay and the fail-closed bridge behavior.

**Non-Goals:**

- Do not change the Pi Bridge wire protocol or IAR execution/policy rules.
- Do not persist Pi Agent transcript or reasoning to browser storage.
- Do not make a new browser tab share a session ID.
- Do not promise recovery after the Pi Host process itself restarts; that would
  require a durable Pi transcript and bridge mapping design beyond this fix.

## Decisions

### 1. Retain server sessions after SSE disconnect

`buildPiHostApp` will keep `PiHostSession` in its session map after an SSE
client closes. Each entry records `lastUsedAt`; resolving a session, posting a
chat/confirm request, or attaching an SSE client refreshes that timestamp.
This preserves the existing delegate and bridge mapping without replaying
user input, unlike a client-side history injection approach.

The server will use a bounded idle lifetime (30 minutes by default, matching
the sandbox session default) and a timer whose reference does not keep the
process alive. A sweep only disposes entries with no connected clients and an
expired `lastUsedAt`.

### 2. Make clear an explicit server operation

Add `DELETE /api/pi-host/session/:sessionId` with the session ID in the path,
so the browser's clear action can release the exact old server session. The
route is idempotent for an already-expired or unknown Pi Host session and
returns a stable success response; malformed IDs remain a client error. The
page calls this route before replacing its local session ID and reconnecting.

This is preferable to relying on SSE close as a reset signal because refresh
and clear have different semantics. It also makes cleanup testable and avoids
retaining a deliberately cleared Pi Agent transcript until the idle timer.

### 3. Synchronize pending confirmation from the session owner

`PiHostSession` will observe the existing bridge `state` and confirm hooks,
retain only the sanitized `BridgePendingAction | null`, and expose a read-only
snapshot method. The SSE route sends a `confirm` event after the ready event
and after the client is registered. The browser already treats `confirm: null`
as the command to remove stale cards, so reconnect synchronization remains
compatible with live confirm events.

The snapshot contains only action ID, run ID, Function/Plugin IDs, risk level
and confirmation-required status. It never includes Action input, prompt,
reasoning or model payload.

### 4. Keep transport and session cleanup separate

SSE close will remove only the client from the per-session client set. A
session is disposed by explicit DELETE, idle sweep, or `closeClients` during
server shutdown. The server will close its sweep timer and dispose all
remaining sessions during shutdown, while retaining current client close
behavior.

### 5. Test at the session boundary

The primary regression test will use the real `buildPiHostApp` and a stateful
fake bridge/Pi delegate. It will connect SSE, submit a turn, close the SSE
connection, reconnect with the same session ID, and assert that the original
delegate and IAR session are reused. Separate tests cover pending-state replay,
explicit clear, isolated IDs and expiry using an injected short idle lifetime.
Page-template tests will assert the DELETE call and reconnect-safe confirm
handling without requiring a full browser runtime.

## Risks / Trade-offs

- [Risk] A disconnected page can retain an in-memory transcript longer than
  before. → Use a bounded idle lifetime and sweep only detached sessions.
- [Risk] A clear request may race with an active turn. → The page disables the
  clear control while busy; the server rejects deletion while a session has an
  active operation rather than disposing a live delegate.
- [Risk] A stale confirmation card could remain after reconnect. → Always send
  a current `confirm` event, including `null`, immediately after `ready`.
- [Risk] Multiple tabs could intentionally reuse a copied session ID. → Keep
  the existing opaque ID validation and do not change browser ID generation;
  authentication and tenant ownership remain outside this demo scope.

## Migration Plan

1. Add boundary tests for retention, status replay, clear and expiry.
2. Implement the server/session lifecycle changes and page DELETE call.
3. Run focused Pi Host tests, build, and the full test suite.
4. Rollback is code-only: restore SSE-close disposal and remove the clear route;
   no data migration is required because the retained state is in memory.
