# Tasks

## 1. Semantic and route diagnostics

- [x] 1.1 Add a failing safe-log test for trace-correlated semantic frame and route gate diagnostics, then implement bounded bilingual logging for field presence, missing-field reason, candidate count, next stage and stable route reason without raw input or model payloads.
- [x] 1.2 Add a failing turn test proving incomplete semantic extraction records skipped `route.propose`/`action.execute` and distinct route evidence, then wire the diagnostic at the semantic and routing boundaries; verify focused observability and Sandbox tests pass.

## 2. Deterministic recovery clarification

- [x] 2.1 Add a failing test for an incomplete action request and repeated confirmation proving the runtime returns a bounded missing-field clarification instead of invoking execution or treating Response Model text as authorization.
- [x] 2.2 Implement structured missing-field recovery and re-extraction gating using existing BehaviorContext/pending clarification boundaries; verify valid user-supplied fields re-enter normal route, policy and confirmation checks and invalid values remain blocked.

## 3. Integration verification

- [x] 3.1 Add or update regression coverage for extraction omission, candidate-empty, bridge failure and successful execution, and verify each outcome has a distinct safe log reason and timing record.
- [x] 3.2 Run `openspec validate recover-semantic-routing-gaps --strict`, build, lint, focused tests and the full test suite; review the diff for logging privacy, backend reliability, route authority and compatibility before marking the change complete.

## Workflow follow-up

- Archive the OpenSpec change after implementation review and per-task audit pass.
- Merge each verified task branch into the confirmed `master` integration branch and verify the final integration branch contains the complete change.
