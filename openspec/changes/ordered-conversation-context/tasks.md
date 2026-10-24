## 1. Contracts and event projection

- [x] 1.1 Add bounded `ConversationTurn`, `ConversationTurnHistory`, schema, event name/payload, and backward-compatible optional fields to `BehaviorContext`; include the turn history in critical-state hashing and initial context creation. Verify with contract schema tests and a RED/GREEN compatibility test for old snapshots.
- [ ] 1.2 Add `conversation.turn.completed` event creation and projection. Enforce session ownership, monotonic sequence, bounded text, duplicate turn-id idempotency, and independent turn focus without changing fact focus. Verify with unit and replay tests for valid, duplicate, stale, foreign, and malformed events.

## 2. Session completion and recovery integration

- [ ] 2.1 Record exactly one completed conversation turn at the shared final-reply boundary for normal, confirmation, clarification, failed, and streaming paths. Do not commit partial/interrupted streams, and do not double-record retries or message writes. Verify with session integration tests covering each completion path.
- [ ] 2.2 Persist and restore the ordered turn collection through snapshots, event replay, and compaction while retaining the existing bounded raw-message window and fact history. Verify restart, refresh, compaction, and legacy-snapshot tests.

## 3. Scope-aware references and model context

- [ ] 3.1 Extend semantic reference contracts and adapters with explicit `conversation_turn` and `fact_history` scopes, stable IDs/sequences, and bounded relations while preserving legacy compatibility. Verify adapter and validation tests.
- [ ] 3.2 Implement one generic ordered resolver for the two scopes and remove Runtime dependence on fixed natural-language keyword/ordinal parsing. Validate only model-provided scope, target, relation, bounds, and session ownership; unresolved references must use existing clarification flow. Verify relation and security tests.
- [ ] 3.3 Expose separately sorted `<conversation_turns>` and `<fact_history>` collections plus independent focus IDs to semantic and response models. Make the ordered collections authoritative and raw messages supplementary; ensure fallback answers enumerate all relevant records instead of only the current focus. Verify prompt-contract and scripted-provider tests.

## 4. End-to-end regression and release gates

- [ ] 4.1 Add normal/stream/restart scenarios proving that two created tickets, previous-question references, numbered turn references, and fact references remain distinct and ordered without accidental duplicate creation. Verify ticket count, event sequence, restored turn order, and action authorization.
- [ ] 4.2 Run the complete test/build/lint suite, OpenSpec strict validation, per-task code-review and reliability audits, then merge the task branches into `master` and archive the completed change. Record command evidence and any non-blocking dependency warnings.
