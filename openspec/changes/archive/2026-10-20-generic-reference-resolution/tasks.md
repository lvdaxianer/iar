# Tasks

## Contracts and runtime

- [x] Add bounded `PendingReference` contract and include it in BehaviorContext validation and critical-state hashing.
- [x] Add candidate-aware fact relation resolution with deterministic, bounded, append-only results.
- [x] Project pending reference state through clarification events and compaction allow-lists.

## Sandbox integration

- [x] Persist ambiguous reference candidates, pass them to model fallback/response inputs, and block routing/execution until resolved.
- [x] Clear resolved or stale pending reference state and preserve generic unresolved-streak capability selection.

## Tests and verification

- [x] Add RED/GREEN tests for candidate resolution, replay, stale candidates, and no-execution behavior.
- [x] Run contract, runtime, sandbox, persistence, build, OpenSpec validation and review checks.
