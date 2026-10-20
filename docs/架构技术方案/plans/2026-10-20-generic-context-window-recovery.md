# Generic Context Window and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded recent-message window, dynamic Plugin-described clarification, and restart-safe persistence without putting business knowledge in Runtime.

**Architecture:** Keep validated `BehaviorContext` as trusted state, keep complete messages in the existing Provider message source, and derive a bounded latest-N model window after restore. Build all candidate and selection data from the current enabled/authorized Plugin descriptors, then send selections through the existing route, policy, confirmation, and idempotency gates.

**Tech Stack:** TypeScript 7, Node test runner, Fastify sandbox, SQLite persistence Provider, OpenSpec `spec-driven` workflow.

---

## Task 1: Extend generic contracts and the persistence SPI

**Files:**

- Modify: `packages/contracts/src/types-state.ts`
- Modify: `packages/contracts/src/schema-context.ts`
- Modify: `packages/persistence-spi/src/types.ts`
- Test: `tests/contract/contracts.test.ts`
- Test: `tests/contract/persistence-provider.test.ts`
- Test: all Provider test doubles implementing `SessionPersistenceProvider`

- [ ] **Step 1: Write the failing contract tests.** Add cases asserting that a valid context can carry optional bounded clarification state, oversized state is rejected, and a bounded message query accepts a positive limit while rejecting invalid limits.

```ts
test('accepts bounded clarification state and rejects oversized candidate data', () => {
  const valid = contextFixture({ clarification: { streak: 1, mode: 'selection', candidateKeys: ['candidate-a'] } });
  assert.equal(validateContract('behaviorContext', valid).ok, true);
  const invalid = contextFixture({ clarification: { streak: 1, mode: 'selection', candidateKeys: Array.from({ length: 65 }, (_, index) => `candidate-${index}`) } });
  assert.equal(validateContract('behaviorContext', invalid).ok, false);
});
```

- [ ] **Step 2: Run the focused RED command.** Run `npm run build && node scripts/run-tests.mjs tests/contract/contracts.test.ts tests/contract/persistence-provider.test.ts` and confirm the new assertions fail because the fields and bounded read contract do not exist.
- [ ] **Step 3: Implement the generic types and schemas.** Add a data-only clarification state with bounded streak, mode and opaque candidate keys. Add a Provider method accepting `{ limit: number }` and returning chronological messages. Keep new snapshot fields optional so existing SQLite snapshots validate with defaults.
- [ ] **Step 4: Update Provider test doubles.** Add the bounded read method to every test Provider and return a deterministic ordered slice; do not add business-specific data or selection logic to the SPI.
- [ ] **Step 5: Run the focused GREEN command.** Re-run the contract and Provider tests, then run `npm run build`; require exit code 0 and no schema or TypeScript errors.
- [ ] **Step 6: Commit the atomic contract change.** Use the project full commit format with `Refs: OpenSpec generic-context-window-recovery task 1`.

## Task 2: Implement bounded SQLite reads and restart recovery

**Files:**

- Modify: `packages/persistence-sqlite/src/provider.ts`
- Modify: `packages/persistence-sqlite/src/worker.ts`
- Modify: `examples/agent-sandbox/src/session-core.ts`
- Test: `tests/integration/persistence-provider.test.ts`
- Test: `tests/integration/agent-sandbox/session-persistence.test.ts`

- [ ] **Step 1: Write the failing bounded-read test.** Persist more messages than the configured window and assert the Provider returns only the latest N in chronological order, with no duplicated snapshot field.

```ts
const recent = await provider.listMessages(identity.sessionId, { limit: 2 });
assert.deepEqual(recent.map((message) => message.content), ['message-2', 'message-3']);
```

- [ ] **Step 2: Run the RED command.** Run `npm run build && node scripts/run-tests.mjs tests/integration/persistence-provider.test.ts` and confirm the limit signature or expected bounded result fails.
- [ ] **Step 3: Implement the SQLite bounded query.** Add a worker request carrying `limit`, query the existing `iar_session_messages` table with descending sequence and `LIMIT`, parse only validated messages, reverse the result, and preserve current idempotency and worker error boundaries.
- [ ] **Step 4: Write the failing restart test.** Persist a session snapshot and more than N user/assistant messages, close the first server, resume the same session, capture the next model input, and assert the input contains only the latest N messages while trusted facts remain in `BehaviorContext`.
- [ ] **Step 5: Restore the window after the snapshot.** In `session-core.restoreSnapshot()`, load the valid structured snapshot first, call the bounded Provider read second, and assign a safe empty window when the message read fails. Do not place raw message values in facts, routing scope, or authorization state.
- [ ] **Step 6: Run GREEN and recovery verification.** Run `npm run build && node scripts/run-tests.mjs tests/integration/persistence-provider.test.ts tests/integration/agent-sandbox/session-persistence.test.ts tests/integration/agent-sandbox/structured-compaction-persistence.test.ts`; require restart, revision, and compaction tests to pass.
- [ ] **Step 7: Commit the persistence change.** Use `Refs: OpenSpec generic-context-window-recovery task 2` in the full commit message.

## Task 3: Inject dynamic Plugin descriptors and bounded messages into model calls

**Files:**

- Modify: `packages/plugin-host/src/*` only where a generic descriptor projection is missing
- Modify: `packages/decision/src/model-gateway/adapters.ts`
- Modify: `examples/agent-sandbox/src/models/model-input-transport.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session-replies.ts`
- Modify: `examples/agent-sandbox/src/session-stream-turn.ts`
- Test: `tests/integration/model-gateway/structured-context.test.ts`
- Test: `tests/routing/scoped-plugin-routing.test.ts`
- Test: `tests/integration/agent-sandbox/session-model-backend.test.ts`

- [ ] **Step 1: Write RED tests for dynamic inputs.** Capture semantic and response provider inputs and assert they contain bounded recent messages and descriptors derived from the current PluginHost. Add an assertion that a shared prompt does not enumerate sample business functions or inspect business keywords.
- [ ] **Step 2: Run the RED command.** Run `npm run build && node scripts/run-tests.mjs tests/integration/model-gateway/structured-context.test.ts tests/routing/scoped-plugin-routing.test.ts tests/integration/agent-sandbox/session-model-backend.test.ts` and confirm the captured input lacks the new fields or still uses the static catalog.
- [ ] **Step 3: Implement the generic descriptor projection.** Project only enabled, authorized Plugin manifest data: opaque candidate ID, Function/Plugin IDs, description, fixed action types and declared operations. Filter by current scope before exposing candidates; never parse message keywords in Runtime.
- [ ] **Step 4: Extend the shared input builders.** Add a bounded recent-message field and dynamic descriptor field to semantic/fallback/response input shapes. Keep compaction input limited to structured state and events. Label both context classes as untrusted data in prompts.
- [ ] **Step 5: Keep stream and non-stream inputs identical.** Thread the same context builder through `session.ts`, `session-stream-turn.ts`, and `session-replies.ts`; avoid separate prompt assembly branches.
- [ ] **Step 6: Run GREEN.** Re-run the focused model, routing, and session tests and require all dynamic descriptor, prompt safety, compaction exclusion, and stream parity assertions to pass.
- [ ] **Step 7: Commit the model-context change.** Use `Refs: OpenSpec generic-context-window-recovery task 3` in the full commit message.

## Task 4: Add generic unresolved escalation and selection re-entry

**Files:**

- Modify: `packages/contracts/src/types-state.ts` if clarification state needs the final field shape
- Modify: `examples/agent-sandbox/src/session-core.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session-replies.ts`
- Modify: `examples/agent-sandbox/src/http-session-routes.ts` only if selection input needs a public response field
- Test: `tests/integration/agent-sandbox/session-refactor-behavior.test.ts`
- Test: `tests/integration/agent-sandbox/e2e-structured-context.test.ts`

- [ ] **Step 1: Write RED tests for the state machine.** Assert that one unresolved result produces normal clarification, the configured threshold produces dynamic descriptor options, confirmation waits do not increment the streak, successful progress resets it, and an empty candidate set does not fabricate options.
- [ ] **Step 2: Run the RED command.** Run `npm run build && node scripts/run-tests.mjs tests/integration/agent-sandbox/session-refactor-behavior.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts` and confirm the current implementation repeats clarification without a durable escalation state.
- [ ] **Step 3: Implement streak transitions.** Increment only stable unresolved semantic/routing/input outcomes, persist the bounded state through the snapshot path, reset on confirmation or successful execution, and make the threshold configurable with a default of two.
- [ ] **Step 4: Implement dynamic selection.** Build options from the current authorized descriptors, use opaque candidate keys, persist the pending selection, and validate the key against a fresh registry snapshot before narrowing the route. Invalid or stale choices remain clarification responses.
- [ ] **Step 5: Re-enter the normal route.** After a valid selection, constrain the candidate scope and execute the same semantic, route, authorization, policy, confirmation and idempotency pipeline; never invoke a Plugin directly from selection handling.
- [ ] **Step 6: Run GREEN and end-to-end verification.** Run `npm run build && node scripts/run-tests.mjs tests/integration/agent-sandbox/session-refactor-behavior.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts tests/integration/agent-sandbox/web-sessions.test.ts` and verify restart during pending selection behaves the same as an in-memory session.
- [ ] **Step 7: Commit the escalation change.** Use `Refs: OpenSpec generic-context-window-recovery task 4` in the full commit message.

## Task 5: Remove static Runtime business assumptions and complete verification

**Files:**

- Modify: shared Runtime/model prompt files that still contain static feature catalogs or keyword routing
- Test: `tests/integration/model-gateway/intent-prompt.test.ts`
- Test: `tests/integration/model-gateway/intent-prompt-security.test.ts`
- Test: `tests/contract/persistence-provider.test.ts`
- Test: `tests/integration/agent-sandbox/safe-observability-session.test.ts`
- Review: `openspec/changes/generic-context-window-recovery/*`

- [ ] **Step 1: Search for forbidden static assumptions.** Run `rg -n "转人工|工单|知识库|human\.transfer|ticket\.create|function list|availableFunctions" packages/runtime packages/decision packages/persistence-spi packages/persistence-sqlite` and classify every result as generic contract, test fixture, or prohibited Runtime behavior.
- [ ] **Step 2: Remove or isolate prohibited assumptions.** Keep sample business descriptors only under the example Plugin application; shared Runtime and prompt builders consume injected descriptors and never branch on business text.
- [ ] **Step 3: Run focused verification.** Run `openspec validate generic-context-window-recovery --strict` and the full relevant test groups: `npm run build`, `npm run lint`, `node scripts/run-tests.mjs tests/contract tests/integration/persistence-provider.test.ts tests/integration/model-gateway tests/routing tests/integration/agent-sandbox`.
- [ ] **Step 4: Run repository verification.** Run `npm test`, `npm run verify:packages`, and inspect `git diff --check`; record exit codes and failing test counts before claiming completion.
- [ ] **Step 5: Perform review and task audit.** Compare implementation against the OpenSpec requirements, design decisions, canonical code-review/backend reliability/frontend interaction/logging rules, and this plan. Fix any critical or should-fix issue before marking the corresponding OpenSpec checkbox complete.
- [ ] **Step 6: Commit the final verification/documentation update.** Use `Refs: OpenSpec generic-context-window-recovery task 5` in the full commit message.

## Workflow follow-up

- Ask the user to review the written design and plan before implementation begins.
- After implementation and verification, run the OpenSpec verification report, synchronize approved delta specs, archive the completed change, and merge the task branch into the clean `master` integration checkout.
