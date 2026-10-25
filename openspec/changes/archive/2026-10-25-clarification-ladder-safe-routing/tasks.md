# Tasks

## 1. Operation clarification and continuation

- [x] 1.1 Add focused integration coverage for a matched Function without a uniquely evidenced Operation; verify `operation_missing`, bounded catalog output, no pending Action, and no Handler invocation.
- [x] 1.2 Implement evidence-based Operation resolution, same-Function continuation, and fail-closed mixed read/action routing; verify focused clarification, confirmation, and invalid-selection tests pass.
- [x] 1.3 Preserve verified Function/Plugin and named slots across same-session Operation and parameter answers; verify the continuation regression tests pass without cross-Function execution.

## 2. Real-model semantic evaluator

- [x] 2.1 Add a data-driven semantic assertion layer for the pasted 50-scenario ladder; verify it checks disposition, route identity, reason code, catalog/slot evidence, pending state, and single-session continuity.
- [x] 2.2 Run the evaluator against `http://127.0.0.1:8878` with one fixed `piSessionId`; verify the evaluator exits non-zero on semantic failures and exits zero for the final 50-scenario run.

## 3. Verification and audit

- [x] 3.1 Run build, lint, focused integration tests, and the full `npm test`; verify all commands exit zero and the full suite reports 855 passing tests.
- [x] 3.2 Run `openspec validate clarification-ladder-safe-routing --strict`, audit generic-only production changes, and verify the final diff has no whitespace errors.

## Workflow follow-up

- Archive the completed change after the implementation review and per-task audit pass.
- Merge the verified task branch into the recorded `master` integration branch and verify the integration checkout contains the complete change.
