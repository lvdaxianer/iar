# Tasks

## 1. Built-in self-introduction Agent capability

- [x] 1.1 Add the built-in self-introduction Plugin, Agent creation configuration, scoped Plugin filtering, sandbox semantic/reply integration, focused regression tests, and public design documentation; verify with the focused self-introduction/runtime/sandbox tests, `npm run build`, `npm test`, and `openspec validate add-self-introduction-plugin --strict`.

### Task 1.1 boundary and dispatch plan

- Module-oriented owner: `self-introduction-runtime-integration` (direct main-agent execution).
- Owned responsibility: `@iar/plugins` built-in Plugin and bounded inventory; `@iar/runtime` Agent configuration and default filtering; sandbox creation/session/reply integration; focused tests and design/spec artifacts.
- Allowed files/modules: `packages/plugins/**`, `packages/runtime/src/bootstrap/**`, `examples/agent-sandbox/src/**`, focused tests under `tests/contract/**`, `tests/integration/agent-sandbox/**`, `tests/integration/model-gateway/**`, and this change's OpenSpec/design files.
- Out of scope: Pi source changes, persistence schema changes, new external dependencies, unrelated Plugin refactors, and UI/page creation.
- Dependencies: existing `PluginHost`, `PluginDescriptor`, `createIarRuntime`, sandbox `ActionExecutor`, and current model response contracts.
- Focused verification: `npm test -- --test-name-pattern self-introduction` (or the repository's equivalent focused test invocation), plus the directly affected contract and sandbox test files.
- Broader verification: `npm run build`, `npm test`, and `openspec validate add-self-introduction-plugin --strict`.
- Handoff evidence: failing RED assertions, passing GREEN focused tests, full test/build output, diff review, per-task audit, and one atomic commit.
- Direct-execution fallback: delegation is not useful here because the runtime option, built-in Plugin input shape, and sandbox response path share the same contracts and would otherwise create overlapping write scopes; the main agent will keep the feature in one bounded task.

## Workflow follow-up

- Mark task 1.1 complete only after RED, GREEN, broader verification, plan audit, code-review-spec, per-task audit, and commit gates pass.
- Merge the task branch into the `.source_branch` integration branch, run final audit, and archive this OpenSpec change.
