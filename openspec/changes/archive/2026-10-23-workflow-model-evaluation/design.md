# Design

## Context

The production sandbox already has one semantic prompt builder, a bounded `BehaviorContext`, normal and streamed session entry points, and fail-closed route and execution gates. The experiment must observe those boundaries rather than introduce a second model protocol. See `proposal.md` for the motivation and scope.

## Goals / Non-Goals

**Goals:**

- Build a reusable scenario corpus that represents realistic multi-turn user requests and explicit structured workflow states.
- Verify that every scenario sends the production semantic prompt, current message, bounded recent messages, collection state, route evidence, pending state, confirmation state, and authorized descriptors as applicable.
- Derive the expected next runtime stage from the validated model frame and current context, then compare it with the actual normal and streamed session result.
- Provide an opt-in real-model run without changing the default deterministic test suite or granting model output execution authority.

**Non-Goals:**

- Do not add a production `workflow.transition` model role or change the `SemanticFrame` contract.
- Do not let the model select a Plugin/Function outside the runtime-filtered descriptors.
- Do not execute external side effects during evaluation; use the existing sandbox handlers and confirmation gates.
- Do not log raw prompts, model responses, parameter values, or credentials.

## Decisions

### Reuse the production semantic prompt and context builder

The evaluator will call `buildSemanticUserPrompt()` and use `SEMANTIC_SYSTEM_PROMPT` through the existing provider path. This prevents a test-only prompt from hiding failures in the real prompt. A prompt-capture provider will assert the exact structured sections and descriptor filtering.

Alternative rejected: adding a separate evaluation prompt that directly asks for a transition. That would test a new protocol rather than the current model behavior.

### Use scenario fixtures plus end-to-end session probes

Each case contains a user-message sequence, a bounded initial context fixture or public-session prelude, expected route/state invariants, and whether the same case must run through `turn()` and `turnStreamed()`. Fixtures cover states that are difficult to reach deterministically through a public prelude; session probes validate the actual orchestration path.

### Evaluate the runtime stage, not free-form model prose

The evaluator maps the validated `SemanticFrame` and `BehaviorContext` to an expected bounded outcome such as parameter clarification, confirmation, execution, unavailable, or pass-through. It compares route evidence, collection state, and Pi reachability rather than comparing natural-language replies. This keeps the experiment stable across harmless wording changes.

### Gate real-model execution explicitly

The deterministic suite always runs with the existing scripted provider and never requires network access. A separate command or opt-in test runs the same scenario corpus with `IAR_LLM_BASE_URL`, `IAR_LLM_API_KEY`, and `IAR_LLM_MODEL_ID`; absent credentials, it reports that real-model measurements were not run instead of silently treating scripted output as model accuracy.

### Keep security assertions mandatory in both modes

Every case checks that recovered or model-proposed data cannot bypass descriptor revalidation, schema validation, policy, idempotency, confirmation, or Handler execution. Disabled or unauthorized descriptors are asserted absent from the captured prompt and unavailable from the route result.

## Risks / Trade-offs

- [Risk] Scripted mode cannot measure semantic model comprehension → label it as contract/orchestration coverage and only report model accuracy for the opt-in real-model run.
- [Risk] Real model output is nondeterministic and may change with provider versions → record model/profile metadata and bounded structured results, but do not make real-model tests part of `npm test`.
- [Risk] A large corpus can make failures hard to diagnose → give every scenario a stable ID and report the first failed stage, route evidence, and expected/actual bounded outcome.
- [Risk] Prompt snapshots may accidentally contain sensitive values → use synthetic descriptors and values only, redact captured payloads in reports, and never persist raw model transport bodies.

## Migration Plan

No production migration is required. Add the evaluator and tests, run deterministic verification, then optionally run the real-model command with explicitly supplied credentials. Removing the experiment only removes test/evaluation artifacts.
