# Tasks

## 1. Contracts and Provider SPI

- [x] 1.1 Add failing contract tests for bounded recent-message input, backward-compatible clarification state, and invalid oversized or malformed selection data in `tests/contract/contracts.test.ts`; verify the focused contract command fails for the new cases before implementation.
- [x] 1.2 Add the generic recent-message policy and persisted unresolved/selection state to `packages/contracts/src/types-state.ts` and `packages/contracts/src/schema-context.ts`; keep old snapshots valid through optional fields and verify `npm test -- --test-name-pattern='contract|behaviorContext'` passes after the implementation.
- [x] 1.3 Extend `packages/persistence-spi/src/types.ts` with a bounded ordered recent-message read and update every test/dummy Provider implementation; verify `tests/contract/persistence-provider.test.ts`, `tests/integration/persistence-provider.test.ts`, and TypeScript build pass.

## 2. SQLite Message Window and Session Recovery

- [x] 2.1 Write failing SQLite tests covering latest-N ordering, zero/oversized limits, and message-store reuse in `tests/integration/persistence-provider.test.ts`; verify the new tests fail for the current unbounded `listMessages` implementation.
- [x] 2.2 Implement the bounded query in `packages/persistence-sqlite/src/provider.ts` and `packages/persistence-sqlite/src/worker.ts` without adding a duplicate raw-message snapshot table; verify the SQLite focused tests pass and existing idempotency/revision tests remain green.
- [ ] 2.3 Write a failing restart regression in `tests/integration/agent-sandbox/session-persistence.test.ts` that persists more than N messages, restarts the session, and asserts only the latest ordered window is supplied to the next model call; verify it fails before restore wiring.
- [ ] 2.4 Update `examples/agent-sandbox/src/session-core.ts` and persistence adapters to restore the structured snapshot first, load the bounded message window second, and fail safe to an empty window when the message read is unavailable; verify file-backed resume restores both state classes without exposing message text as trusted facts.

## 3. Dynamic Plugin Descriptors and Model Context

- [ ] 3.1 Add failing tests for descriptor collection, authorization filtering, opaque candidate keys, recent-message bounds, and prompt inputs with no static business catalog in `tests/integration/model-gateway/structured-context.test.ts` and routing tests; verify the tests fail against the current hardcoded prompt/input shape.
- [ ] 3.2 Implement a generic PluginHost descriptor projection from enabled, authorized Plugin manifests, including declared Function/Plugin IDs, descriptions, action types, and operation metadata; verify candidates are generated only from the current registry and no core Runtime source contains business-specific names or keyword branches.
- [ ] 3.3 Extend the semantic extraction and response-generation input builders in `examples/agent-sandbox/src/models/model-input-transport.ts`, `packages/decision/src/model-gateway/adapters.ts`, and session routing/reply contexts to pass bounded recent messages and dynamic descriptors while keeping compaction input structured-only; verify prompt contract tests and model gateway tests pass.
- [ ] 3.4 Add parity tests for `session.ts` and `session-stream-turn.ts` proving streaming and non-streaming calls receive equivalent recent-message, descriptor, and clarification inputs; verify both paths preserve the existing no-side-effect-on-uncertain behavior.

## 4. Generic Clarification Escalation and Selection

- [ ] 4.1 Write failing session tests for unresolved streak increments, threshold escalation, reset after confirmation/success, empty-candidate fallback, and stale selection rejection in `tests/integration/agent-sandbox/session-refactor-behavior.test.ts` or a focused new test file; verify the current implementation repeats generic clarification and has no durable streak.
- [ ] 4.2 Implement bounded clarification state transitions in the session/runtime layer, counting only semantic/routing/input clarification outcomes and persisting the state through the existing context snapshot path; verify focused state tests pass and confirmation waits do not increment the streak.
- [ ] 4.3 Implement dynamic selection responses from current authorized Plugin descriptors and validate opaque user selections against the current candidate set before narrowing the normal route; verify no selection path invokes a Plugin directly and invalid/stale keys remain outside execution.
- [ ] 4.4 Add end-to-end regression coverage for a colloquial follow-up understood through recent messages, two unresolved turns escalating to dynamic choices, a valid choice re-entering the normal policy/confirmation path, and a restart during selection; verify `tests/integration/agent-sandbox/e2e-structured-context.test.ts` passes.

## 5. Review, Compatibility, and Verification

- [ ] 5.1 Remove or isolate static business catalogs from shared Runtime/model prompt code while preserving sample Plugin descriptors inside the example application; verify `rg` finds no business-specific keyword routing in core packages and all descriptor-based tests pass.
- [ ] 5.2 Run OpenSpec validation and the focused contract, persistence, model-gateway, routing, and agent-sandbox suites; verify `openspec validate generic-context-window-recovery --strict`, `npm test`, `npm run lint`, and `npm run verify:packages` complete successfully.
- [ ] 5.3 Perform the per-task code-review and plan-implementation audit against the canonical code-review, backend reliability, frontend interaction, logging, and verification skills; record findings and evidence before marking implementation tasks complete.

## Workflow follow-up

- Archive `generic-context-window-recovery` only after all tracked tasks, verification, review, and spec synchronization requirements pass.
- Merge the task branch into the recorded `SOURCE_BRANCH=master` only from a clean integration checkout, preserving the unrelated `pnpm-lock.yaml` change.
