# Proposal

## Why

The repository already sends the real semantic prompt and bounded structured session context to the model, but it does not yet have a repeatable experiment that exercises continuation, parameter collection, cancellation, authorization, confirmation, and new-topic transitions together. Without such a corpus, a passing unit test can prove prompt wiring while leaving the model's interpretation of workflow context unmeasured.

## What Changes

- Add an evaluation-only scenario corpus covering normal, continuation, parameter, clarification, cancellation, authorization, confirmation, and pass-through paths.
- Reuse the production semantic prompt builder and the same structured `BehaviorContext` shape used by normal and streaming sessions.
- Add an offline evaluator that validates prompt/context completeness, expected transition derivation, and fail-closed security invariants without calling a real model.
- Add an opt-in real-model runner that uses the configured model provider and records bounded evaluation results without changing execution authorization.
- Keep all evaluation artifacts outside the production execution protocol; model output remains untrusted data.

## Capabilities

### New Capabilities

None. This is an evaluation-only and test-only change.

### Modified Capabilities

None. No runtime behavior or production contract is changed.

## Impact

- Affected areas: `tests/`, `scripts/`, and evaluation documentation under `openspec/changes/`.
- No public API, Plugin registry, authorization, policy, confirmation, or Handler behavior changes.
- The real-model runner requires the existing model environment variables only when explicitly enabled; default tests remain offline and deterministic.
