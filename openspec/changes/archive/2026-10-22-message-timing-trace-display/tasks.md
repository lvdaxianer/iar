# Tasks

## 1. Response timing and trace display

- [x] 1.1 **RED** — Extend Sandbox/Pi host page tests to require duration formatting, short trace meta, full Timing trace field, and Pi host timing cleanup. Keep tests limited to the static page contract and real timing event flow.
- [x] 1.2 **GREEN** — Implement shared behavior within the existing page fragments: format duration/trace safely, append timing meta to response messages, render full trace in Timing panels, and associate/clear Pi host pending timing for entry, stream, fallback, and completion paths.
- [x] 1.3 **VERIFY** — Run focused page/session tests and the full `npm test`; review frontend interaction checklist, DOM safety, method-size constraints, and ensure no backend/logging contract changes were introduced.

## Task boundary and dispatch

- Scope is limited to `examples/agent-sandbox` page fragments/templates and their integration tests.
- No subagent dispatch: the changes share the same static-page assembly and Pi host state, so splitting would create unsafe concurrent edits and duplicate review work.
- Each task is completed only after its tests, review, and per-task audit pass.
