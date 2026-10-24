# Tasks

## Execution boundary and dispatch

- Task 1.1 module agent: `sandbox-pending-context-recovery` (主 agent 直接执行)。
- Responsibility: repair only pending cancellation and post-compaction historical
  status recovery at the session runtime boundary.
- Allowed files/modules: `examples/agent-sandbox/src/session*.ts`,
  `examples/agent-sandbox/src/models/model-input-transport.ts`, and focused
  `tests/integration/agent-sandbox/*` regression files.
- Out of scope: plugin handlers and fixtures, public HTTP/Bridge contracts,
  persistence providers, UI, logging redesign, and model profiles.
- Dependencies: existing continuation-recovery and structured-model-context
  contracts; real 8878 brain is reproduction-only.
- Focused verification: pending cancellation and compaction follow-up tests.
- Broader verification: build, lint, full tests, strict OpenSpec validation, and
  the one-session real-model scenario run.
- Handoff evidence: pending state transition, route evidence, handler call count,
  and proof that confirmation remains required for new actions.
- Direct-execution fallback: safe delegation is not useful because both defects
  share the same serialized session state machine and require sequential route
  evidence.

## 1. Runtime safety repair

- [x] T1.1 Add focused failing tests for natural-language pending cancellation
  and post-compaction historical status follow-up.
- [x] T1.2 Implement the minimal runtime-only fix; preserve existing policy,
  confirmation, handler and public API behavior.
- [x] T1.3 Run focused RED/GREEN tests and broader build/lint/full tests.
- [x] T1.4 Rerun all 50 attached scenarios through one unchanged 8878 real-model
  Pi/IAR session and record route/pending/action evidence.
- [x] T1.5 Complete plan audit, code review, per-task audit, commit and merge to
  `master`; verify the final integration branch.
