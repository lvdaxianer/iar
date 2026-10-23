# Tasks

## 1. Scenario and prompt-capture foundation

- [x] 1.1 Add typed workflow evaluation scenarios with synthetic authorized/disabled descriptors and realistic `BehaviorContext` fixtures; verify the fixture corpus covers initial routing, function selection, parameter collection, confirmation, cancellation, new topic, and pass-through states.
- [x] 1.2 Add prompt-capture assertions using `SEMANTIC_SYSTEM_PROMPT` and `buildSemanticUserPrompt()`; verify current text, bounded history, route, collection, pending, confirmation, workflow state, structured input, and only authorized descriptors are present.

## 2. Offline orchestration evaluation

- [ ] 2.1 Add deterministic evaluation helpers that derive and assert the expected next runtime stage from validated semantic output and structured context; verify no model result can create a new Function/Plugin or bypass normal gates.
- [ ] 2.2 Add normal and streamed session scenario tests for continuation recovery, named-field parameter merge and override, invalid field/type/enum clarification, disabled or missing Plugin/Function, confirmation/decline, user abandonment, new-topic reset, and stable-route unknown semantic frames.
- [ ] 2.3 Add bounded evaluation reporting with stable scenario IDs and redacted summaries; verify default tests do not emit raw prompts, model responses, parameter values, or credentials.

## 3. Opt-in real-model experiment

- [ ] 3.1 Add an explicit real-model runner that reuses the same scenario corpus and production provider configuration, skips with a clear message when credentials are absent, and records only bounded accuracy/transition metrics.
- [ ] 3.2 Run focused tests, lint, build, and the full test suite; verify the experiment remains test-only and production execution behavior is unchanged.

## Workflow follow-up

- Archive the completed OpenSpec change after review and verification.
- Merge the task branch into `master`, verify `master` contains the experiment, then remove the task worktree and branch.
