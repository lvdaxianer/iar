# Tasks

## 1. Baseline and contract guard

- [x] 1.1 Record the current 20-package inventory, dependency graph, public
  entrypoints, project references, and baseline results in
  `docs/implementation-audits/runtime-package-boundaries-baseline.md`; verify
  `npm run lint`, `npm run build`, `npm test`, and `npm run verify:packages` all
  pass before source moves begin.
- [x] 1.2 Add
  `tests/contract/standalone-runtime-entry.test.ts` that imports
  `createIarRuntime` from `@iar/runtime`, initializes one valid Plugin package,
  rejects an invalid Plugin package without partial state, and verifies the
  current Pi bridge remains a separate package; verify the new test is RED
  before the runtime entry is implemented.

## 2. Publishable standalone runtime entry

- [x] 2.1 Add `createIarRuntime` and its option/result types under
  `packages/runtime/src/bootstrap/`, reusing the current atomic PluginHost and
  FunctionRegistry initialization semantics; verify the focused standalone
  runtime test passes and no Pi/HTTP/database module is imported by bootstrap.
- [x] 2.2 Update `packages/runtime/package.json` to remove `private: true`,
  expose the compiled root entry, and export the bootstrap API from
  `packages/runtime/src/index.ts`; verify `npm run lint` and `npm run build`
  resolve JavaScript and declaration files from `@iar/runtime`.
- [x] 2.3 Add the runtime package distribution assertion to
  `scripts/verify-package-distribution.mjs` and update the focused package
  smoke test to inspect the packed `@iar/runtime` contents; verify the check
  rejects source-path leakage and accepts the compiled root entry.

## 3. Consolidate decision and rule implementation

- [x] 3.1 Move `packages/decision/src/*` into
  `packages/runtime/src/intent/decision/` and
  `packages/rule-engine/src/*` into `packages/runtime/src/intent/rules/`;
  preserve exported types and decision result shapes; verify routing and model
  provider tests pass through `@iar/runtime` imports.
- [x] 3.2 Replace all `@iar/decision` and `@iar/rule-engine` manifest,
  project-reference, source, test, example, and documentation consumers with
  the runtime public entry or runtime-internal relative imports; remove the two
  old package manifests only after `npm run lint` and `npm run build` pass.
- [x] 3.3 Update the current routing contract tests so bounded candidates,
  fail-closed validation, and model-provider configuration are exercised after
  consolidation; verify the focused routing suite and `npm test` pass.

## 4. Consolidate workflow and observability implementations

- [x] 4.1 Move `packages/workflow/src/*` into
  `packages/runtime/src/execution/`, update internal imports to the new runtime
  layout, and expose the existing workflow types and local execution APIs from
  the runtime root or declared runtime subpath; verify workflow and replay tests
  pass without changing event or confirmation formats.
- [x] 4.2 Move `packages/observability/src/core/*` and
  `packages/observability/src/system-plugin/*` into
  `packages/runtime/src/observability/`, keep `@iar/subscriptions` as the shared
  event boundary, and preserve redaction and fail-open behavior; verify
  `tests/security/observability.test.ts` passes.
- [x] 4.3 Update `packages/adapters/temporal/package.json`, executor imports,
  workflow tests, and observability tests to consume runtime public exports;
  remove the old workflow and observability package manifests only after their
  focused tests and `npm run build` pass.

## 5. Migrate the unified application entry

- [ ] 5.1 Move the implementation in `packages/agent/src/index.ts` into the
  runtime bootstrap module, export `createIarAgent` as a documented deprecated
  alias of `createIarRuntime` for the migration window, and verify both entry
  names return the same atomic initialization behavior.
- [ ] 5.2 Update all active imports in `examples/**`, `tests/**`, `scripts/**`,
  `README.md`, `docs/unified-entry.md`, and current architecture docs from
  `@iar/agent` to `@iar/runtime`; verify `rg` finds no active source consumer of
  `@iar/agent` outside migration history.
- [ ] 5.3 Remove `packages/agent/package.json` and its build reference after
  consumer migration, add the breaking import migration note to the runtime
  documentation, and verify package discovery reports no `@iar/agent` publish
  artifact.

## 6. Revalidate adapter and infrastructure boundaries

- [ ] 6.1 Update `packages/control-plane`, `packages/adapters/service`,
  `packages/adapters/fastify`, and `packages/adapters/executors` manifests and
  imports to use the consolidated runtime while keeping `storage` and
  `subscriptions` as separate dependencies; verify their focused contract,
  service, distribution, and executor tests pass.
- [ ] 6.2 Keep `packages/adapters/pi` as `@iar/pi-bridge` with its existing
  protocol, Pi extension subpath, and no runtime implementation ownership;
  verify the Pi bridge context-isolation and host demo tests pass unchanged.
- [ ] 6.3 Keep `packages/adapters/postgres` dependent on `@iar/storage` and
  `packages/adapters/temporal` dependent on runtime execution contracts without
  adding database or Temporal dependencies to the runtime core; verify package
  manifests and `npm run verify:packages` enforce the dependency direction.

## 7. Documentation and architecture alignment

- [ ] 7.1 Update `README.md`, `docs/README.md`,
  `docs/plugin-function-architecture.md`, and `docs/unified-entry.md` with the
  final package tree, standalone runtime example, Pi bridge flow, and adapter
  table; verify every current package name in active documentation matches the
  target boundary.
- [ ] 7.2 Add a migration note mapping `@iar/agent`, `@iar/decision`,
  `@iar/rule-engine`, `@iar/workflow`, and `@iar/observability` to runtime
  subdirectories or public exports; verify the note contains no unresolved
  placeholders and all code examples type-check.

## 8. Integration verification

- [ ] 8.1 Run `openspec validate runtime-package-boundaries --strict`,
  `git diff --check`, `npm run lint`, `npm run build`, `npm test`, and
  `npm run verify:packages`; record the results in the implementation audit.
- [ ] 8.2 Run `npm run demo:fake-plugin`, `npm run demo:sandbox -- --brain
  scripted`, and `npm run demo:pi-host`; verify standalone runtime behavior,
  session behavior, and Pi pass-through/handled/confirmation behavior remain
  observable.
- [ ] 8.3 Complete the final architecture review against the package tree,
  dependency direction, public exports, and non-goals in `design.md`; mark the
  OpenSpec change ready for archive only when all prior tasks and verification
  evidence are complete.

## Workflow follow-up

- Archive `runtime-package-boundaries` after implementation, review, and final
  verification pass.
- Merge the task branch back into the confirmed `master` integration branch and
  remove the dedicated worktree only after the integration checkout is clean.
