# Pi Host 刷新后会话恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同一浏览器标签页刷新后继续使用原 Pi Agent/IAR 会话，并恢复待确认状态，同时安全清空和回收服务端会话。

**Architecture:** 保持浏览器现有 session ID 和本地有界历史回放；服务端将 `PiHostSession` 生命周期从 SSE 连接中解耦，按 session ID 保留并按空闲时间回收。`PiHostSession` 只投影脱敏 pending 摘要，SSE 重连在 ready 后同步当前 confirm 状态；清空走显式 DELETE。

**Tech Stack:** TypeScript、Fastify、Node `node:test`、SSE、OpenSpec。

---

### Task 1: Server session retention and explicit clear

**Files:**
- Modify: `examples/agent-sandbox/src/pi-host/pi-host-server.ts`
- Test: `tests/integration/pi-host/pi-host-session.test.ts`
- Docs: `openspec/changes/restore-pi-host-session-on-refresh/*`
- Docs: `docs/superpowers/specs/2026-10-24-pi-host-session-recovery-design.md`

- [x] **Step 1: Write the failing lifecycle test**

  Build the Pi Host app with a stateful fake bridge and injected Pi Agent delegate. Open `/api/pi-host/events?session=reconnect-demo`, submit a turn, close the SSE response, reconnect with the same ID, submit a second turn, and assert the delegate instance and `openSession` mapping are reused. Add a different session ID assertion, a `DELETE /api/pi-host/session/:sessionId` assertion, and a short-idle expiry assertion.

- [x] **Step 2: Run the focused test to verify RED**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-session.test.ts`

  Expected: FAIL because the current SSE close handler deletes and disposes the session, and the clear route does not exist.

- [x] **Step 3: Implement bounded retention**

  Store each map entry as `{ session, lastUsedAt }`, refresh `lastUsedAt` on resolve/request/SSE attach, and remove only detached entries whose timestamp is older than the configured idle lifetime. Add `DELETE /api/pi-host/session/:sessionId`, reject malformed IDs with the existing stable client error, and dispose the exact entry when present. Keep SSE close limited to removing its client and clear the sweep timer plus all sessions in `closeClients`.

- [x] **Step 4: Run the focused lifecycle test to verify GREEN**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-session.test.ts`

  Expected: PASS for same-ID reuse, different-ID isolation, explicit clear, and idle expiry.

- [x] **Step 5: Commit the first atomic task**

  Include the OpenSpec/design assets and server lifecycle implementation in one commit:

  ```bash
  git add openspec/changes/restore-pi-host-session-on-refresh docs/superpowers/specs/2026-10-24-pi-host-session-recovery-design.md docs/superpowers/plans/2026-10-24-restore-pi-host-session-on-refresh.md examples/agent-sandbox/src/pi-host/pi-host-server.ts tests/integration/pi-host/pi-host-session.test.ts
  git commit -m "🐛 fix(pi-host): 保留刷新后的服务端会话上下文\n\n刷新会关闭 SSE 但不应销毁同一标签页的 Pi Agent 和 IAR 会话。本次增加有界保留、显式清空和回归测试。\n\nRefs: OpenSpec restore-pi-host-session-on-refresh task 1.1-1.2"
  ```

### Task 2: Pending confirmation state recovery

**Files:**
- Modify: `examples/agent-sandbox/src/pi-host/pi-host-session.ts`
- Modify: `examples/agent-sandbox/src/pi-host/pi-host-server.ts`
- Test: `tests/integration/pi-host/pi-host-session.test.ts`

- [ ] **Step 1: Write the failing pending-state test**

  Make the fake bridge return a pending action, disconnect and reconnect SSE, and assert the second connection receives a `confirm` event containing only the bounded pending summary. Add the no-pending case and assert it emits `null`.

- [ ] **Step 2: Run RED**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-session.test.ts`

  Expected: FAIL because the current session does not expose its pending state and reconnect sends no state event.

- [ ] **Step 3: Implement state projection and sync**

  Wrap the bridge `state` call and confirmation hooks to retain only `BridgePendingAction | null`. Expose a read-only snapshot on `PiHostSession`. Register the SSE client before resolving the session, send `ready`, then send `confirm` with the current snapshot; emit `null` when absent. Preserve existing live events and never copy Action input.

- [ ] **Step 4: Run GREEN and inspect sensitive fields**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-session.test.ts` and assert serialized SSE data does not contain `input`, prompt text, reasoning, or raw payload fields.

### Task 3: Browser clear and reconnect behavior

**Files:**
- Modify: `examples/agent-sandbox/src/pi-host/web/pi-host.fragment.js`
- Test: `tests/integration/pi-host/pi-host-page.test.ts`

- [ ] **Step 1: Write the failing page-template test**

  Assert the assembled Pi Host adapter posts/deletes `/api/pi-host/session/` with the old session ID before rotating the browser ID, and handles an initial `confirm` event with `null` by clearing stale cards.

- [ ] **Step 2: Run RED**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-page.test.ts`

  Expected: FAIL because the current clear action only removes browser storage and the reconnect handler has no explicit initial-state contract.

- [ ] **Step 3: Implement clear and reconnect handling**

  Add a bounded DELETE helper, make clear disable during busy state and call the helper before closing the old EventSource, then rotate the ID and reconnect. Keep local cleanup even when DELETE fails, display a recoverable message, and ensure `confirm: null` removes stale UI without creating a history entry.

- [ ] **Step 4: Run focused page and integration tests**

  Run: `node --test --import tsx tests/integration/pi-host/pi-host-page.test.ts tests/integration/pi-host/pi-host-session.test.ts`

  Expected: PASS with existing rendering, stream, and clear-session tests unchanged.

### Task 4: Final verification and audit

**Files:**
- Modify: `openspec/changes/restore-pi-host-session-on-refresh/tasks.md`

- [ ] **Step 1: Run OpenSpec and code checks**

  Run: `openspec validate restore-pi-host-session-on-refresh --strict`, `git diff --check`, and the focused Pi Host tests.

- [ ] **Step 2: Run build and full suite**

  Run: `pnpm build` and `pnpm test` from the task worktree; resolve any regression before marking tasks complete.

- [ ] **Step 3: Review the diff against the design and interaction checklist**

  Confirm no task-owned file is outside scope, comments remain Chinese and multiline JSDoc, clear is guarded while busy, session cleanup is bounded, and no sensitive payload is stored or emitted.

- [ ] **Step 4: Run the final OpenSpec verification and commit task markers**

  Run `openspec validate ... --strict` again, mark only verified checkboxes complete, then commit with the required Chinese Conventional Commit body/footer.
