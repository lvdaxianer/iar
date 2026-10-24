# Tasks

## Execution boundary and dispatch

- Task 1.1 module agent: `sandbox-continuation-routing` (主 agent 直接执行)。
- Responsibility: lock the verified `api.gateway` continuation contract and repair only
  incremental numeric continuation recovery.
- Allowed files/modules: `examples/agent-sandbox/src/session*.ts`,
  `examples/agent-sandbox/src/models/model-input-transport.ts`, and focused
  `tests/integration/agent-sandbox/*` regression files.
- Out of scope: plugin fixture semantics, public HTTP contracts, Pi Host UI,
  persistence providers, logging redesign, and unrelated model profiles.
- Dependencies: existing continuation-recovery and structured-model-context
  contracts; the 8878 real brain service is used only for reproduction.
- Focused verification: the new incremental continuation test and its RED/GREEN
  cycle. Broader verification: build, lint, relevant Agent Sandbox integration
  tests, and the single-session real-model scenario run.
- Handoff evidence: route target, merged parameter value, pending confirmation,
  and proof that no Handler executes before confirmation.
- Direct-execution fallback: delegation is unsafe and not useful because the
  reproduction, test, and fix share the same session-routing state machine and
  require sequential real-model evidence.

## 1. Real-model reproduction and contracts

- [x] 1.1 Add a failing regression for a verified API gateway limit followed by the incremental continuation “再往上调 50”; prove the current route is restored, the merged value is 150/s, and confirmation is still required.
- [ ] 1.2 Add a failing regression for an immediately cancelled permission request followed by “刚才那个申请，提交了吗？”, proving the answer stays bound to the cancelled request and does not cite another action.

## 2. Runtime repair

- [x] 2.1 Implement the minimal continuation/parameter recovery fix for incremental numeric updates without widening execution authority or bypassing confirmation.
- [ ] 2.2 Fix any deterministic context-focus defect proven by task 1.2 while preserving verified fact provenance and bounded model context.

## 3. Full real-model verification

- [ ] 3.1 Run focused RED/GREEN tests, build, lint and relevant Agent Sandbox integration tests after each repair.
- [ ] 3.2 Run all 50 attached scenarios through one continuous 8878 `mode=brain` session, handling only the confirmations required by the scenario semantics, and record pass/acceptable/fail evidence.
- [ ] 3.3 Complete plan-implementation audit, code review, per-task audit, commit and integration into `master`.
