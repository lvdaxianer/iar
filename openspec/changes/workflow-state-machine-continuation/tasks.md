# Tasks

## 1. Workflow contract and deterministic transition

- [x] 1.1 Add RED tests for versioned workflow decision validation, bounded event enums and legal/illegal state transitions; implement shared contract and transition reducer without business identifiers.
- [x] 1.2 Add RED tests for deriving workflow context from existing BehaviorContext and implement the bounded projection used by model input and diagnostics.

## 2. Prompt and semantic adapter

- [ ] 2.1 Add RED tests that capture the real semantic prompt with BehaviorContext, collection, confirmation and authorized descriptors, and assert the workflow context/map is present without secrets or unverified capabilities.
- [ ] 2.2 Extend the semantic adapter to parse the workflow decision envelope while preserving legacy semantic-frame compatibility and treating model IDs/next states as non-authoritative.

## 3. Unified session integration

- [ ] 3.1 Add RED integration tests for parameter collection recovery, current-field precedence, invalid fields, disabled Plugin/unavailable Function, cancellation and new-topic transitions.
- [ ] 3.2 Integrate one shared workflow decision/recovery path into ordinary and streamed turns before the semantic incomplete/pass-through gate, preserving Schema, authorization, policy, idempotency and confirmation gates.

## 4. Verification and completion

- [ ] 4.1 Add parity and security regression tests for ordinary/streamed outcomes, illegal model transitions, forged Function/Plugin IDs and no-execution-before-confirmation.
- [ ] 4.2 Run build, lint, focused tests, full test suite and strict OpenSpec validation; perform plan consistency, backend reliability and code review audits, then update this checklist.

## Workflow follow-up

- Merge the verified task branch into `master`, verify the integrated branch, archive the completed OpenSpec change and remove the merged worktree/task branch.
