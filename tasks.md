# Tasks

## 1. Runtime operation clarification

- [x] 1.1 Add RED integration tests proving that a matched Function with no unique Operation returns `operation_missing`, lists only registered Operations, creates no pending Action, and does not invoke a Handler.
- [x] 1.2 Implement evidence-based Operation resolution and bounded Operation catalog clarification; verify existing complete read/action requests and confirmation gates remain green.
- [x] 1.3 Add RED/green same-session tests proving an Operation answer keeps the original Function/Plugin, merges named slots, and asks only for remaining parameters; invalid answers remain blocked.

## 2. Real-model semantic evaluator

- [x] 2.1 Add a semantic assertion layer for the pasted 50-scenario ladder that checks disposition, route identity, reason code, reply catalog/slot keywords, pending state and multi-turn inheritance while preserving one `piSessionId`.
- [x] 2.2 Run the evaluator against `http://127.0.0.1:8878` with a real model and record the first failures as deterministic regression cases; verify the evaluator exits non-zero on a semantic mismatch and zero only when all cases pass.

## 3. Verification and review

- [x] 3.1 Run focused integration tests, build, lint and the full `npm test`; audit route authority, handler safety, session continuity and logging privacy.
- [x] 3.2 Re-run the 50 scenarios on the same 8878 service and one session after every necessary fix; verify all scenarios pass, then run `openspec validate clarification-ladder-safe-routing --strict` and final diff/status audits.

## Workflow follow-up

- [x] Archive the change after implementation review and per-task audit pass.
- [x] Merge each verified task branch into the confirmed `master` integration branch and verify the final integration branch contains the complete change.
