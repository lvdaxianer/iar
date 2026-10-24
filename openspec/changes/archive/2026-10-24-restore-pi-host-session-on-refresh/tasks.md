# Tasks

## 1. Server session lifecycle

- [x] 1.1 Add a failing Pi Host server regression test for SSE disconnect/reconnect, same-ID session reuse, different-ID isolation, explicit clear and idle expiry; verify the new expectations fail against immediate SSE-close disposal.
- [x] 1.2 Implement bounded Pi Host session retention with last-used timestamps, detached-session sweeping, idempotent `DELETE /api/pi-host/session/:sessionId`, and shutdown disposal; verify the lifecycle regression tests pass.

## 2. Pending confirmation recovery

- [x] 2.1 Add a failing session/HTTP test proving a pending confirmation summary is available after reconnect and that no pending state clears stale UI state; verify the test fails before state synchronization exists.
- [x] 2.2 Track only the sanitized pending-action summary in `PiHostSession` and emit the current `confirm` state after SSE `ready`; verify refresh-state tests pass without exposing Action input.

## 3. Browser reconnect and clear behavior

- [x] 3.1 Add a failing page-template regression test for the explicit clear request and reconnect confirm handling; verify the test fails against the current fragment.
- [x] 3.2 Update the Pi Host fragment to delete the old server session before rotating the local ID and to accept reconnect state safely; verify page-template and Pi Host integration tests pass.

## 4. Integration verification

- [x] 4.1 Run OpenSpec strict validation, focused Pi Host tests, TypeScript build, and the full test suite; record any failures and fix them before marking the change complete.

## Workflow follow-up

- Archive the completed OpenSpec change after review, per-task audits, commits and integration merge succeed.
- Verify the final `master` branch contains the merged change and the task worktree is removed only after ancestry checks pass.
