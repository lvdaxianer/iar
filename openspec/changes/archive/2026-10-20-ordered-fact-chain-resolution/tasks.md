# Tasks

## 1. Contracts and bounded fact history

- [x] 1.1 Add RED contract/schema tests for `factHistory`, append-only records, opaque dynamic keys, record bounds, stable IDs and legacy snapshot normalization; implement the versioned `VerifiedFactRecord`/`VerifiedFactHistory` contracts and verify contract tests pass.
- [x] 1.2 Add RED model-gateway tests for generic historical references and invalid IDs; implement the versioned semantic reference relation contract and strict validator without business-specific fields, then verify adapter tests pass.

## 2. Projection and relation resolution

- [x] 2.1 Add RED replay tests for two successful results sharing a field, failed/duplicate events, sequence preservation and focus updates; replace overwrite projection with bounded append-only fact history and verify replay tests pass.
- [x] 2.2 Add RED runtime tests for `current`, `previous`, `next`, `first`, `last` and bounded `offset`, including stale/foreign/ambiguous anchors; implement fail-closed relation resolution and dynamic clarification fallback, then verify no side effect is authorized by a relation alone.
- [x] 2.3 Update context hashing and compaction tests to reject removal, reordering or provenance changes and to preserve the fact chain; verify compaction and replay suites pass.

## 3. Model context and persistence integration

- [x] 3.1 Add RED prompt/input parity tests for current message, recent N raw messages, fact history and dynamic Plugin descriptors across semantic, decision, fallback and response paths; update shared model input construction and generic prompts, then verify streaming and non-streaming inputs are equivalent.
- [x] 3.2 Add RED SQLite/provider restart tests for repeated records, revision conflicts, idempotent events, legacy snapshots and separate raw messages; update snapshot normalization and persistence integration, then verify provider and session-resume suites pass.
- [x] 3.3 Update parameter inheritance and response selection to consume an explicitly resolved fact record rather than all same-key facts; verify historical lookup answers without repeating or authorizing side effects.

## 4. End-to-end verification and delivery

- [x] 4.1 Add an end-to-end regression covering two consecutive results followed by “这个的上一个”, unresolved retries and dynamic function/plugin fallback; verify the earlier result is selected and no unrelated action executes.
- [x] 4.2 Run focused tests, full `npm test`, lint, package verification, build, and `openspec validate ordered-fact-chain-resolution --strict`; record any unrelated baseline failure separately and verify all change-specific checks pass.
- [x] 4.3 Perform the required code review and plan-to-implementation audit, mark completed tasks, commit with OpenSpec traceability, merge the task branch back to `master`, and verify the integration checkout is clean.

## Workflow follow-up

- Archive the completed OpenSpec change after implementation, review, verification and integration gates pass.
- Verify the archived specification and final audit report.
