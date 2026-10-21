# Tasks

## 1. Response policy contract

- [x] 1.1 Add a runtime operation-aware response-policy validator that derives `read`/`action` from the selected operation and rejects an unapproved `direct` or `none` result for a read/query operation; verify with contract tests covering model, direct, none, malformed mode and mixed-operation Functions.
- [x] 1.2 Wire the policy validator into the validated Plugin Handler result path without weakening existing input/output Schema validation; verify that incompatible results fail closed with a stable error and do not enter Workflow or response generation.

## 2. Unified Response Model context

- [x] 2.1 Ensure every successful read/query result uses the shared response-generation path with operation kind, validated Function output, response envelope, Agent prompt layers and bounded structured context; verify with a recording response provider that receives the expected fields.
- [x] 2.2 Preserve self-introduction as structured model input and verify its capability inventory, supplementary prompt and Agent overall prompt reach the model while disabled Plugins remain absent.
- [x] 2.3 Add streaming/non-streaming parity tests proving query results are summarized by Response Model and direct/none results do not invoke it.

## 3. Verified-context follow-up semantics

- [x] 3.1 Classify uniquely resolved fact-based answers separately from unresolved or ambiguous clarification while preserving the no-Function/no-side-effect boundary; verify with ticket-number follow-up, missing-fact and ambiguous-reference tests.
- [x] 3.2 Keep trusted fact provenance and bounded values unchanged, and ensure generated prose is never promoted back into fact history; verify with session state and replay assertions.

## 4. Bridge and Pi Host observability

- [x] 4.1 Propagate selected Function/Plugin identifiers, operation kind, disposition and reply source through the Bridge response while omitting raw prompts and model payloads; verify the HTTP Bridge contract for self-introduction, query, direct, none, Pi Agent and context-answer paths.
- [x] 4.2 Update Pi Host route/event rendering to show Function/Plugin for real routes and a distinct context-answer status for fact-based replies; verify SSE/UI rendering tests and ensure stale route fields are cleared between turns.

## 5. Documentation and integration verification

- [x] 5.1 Update the Function response and Agent prompt documentation with the query/read default, direct/none exceptions, three prompt layers and historical-fact behavior; verify examples match the implemented schemas.
- [x] 5.2 Run OpenSpec strict validation, focused contract/integration tests, package build/type checks and the full repository test suite; verify no regressions in existing self-introduction, confirmation, Pi Bridge or startup behavior.

## Workflow follow-up

- Archive the OpenSpec change after implementation review, verification and task audit pass.
- Merge the task branch back into the confirmed `master` integration branch and remove the worktree only after the branch is clean.
