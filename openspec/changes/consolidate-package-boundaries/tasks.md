# Tasks

## 1. Baseline and migration inventory

- [ ] 1.1 Record the current 18 core packages, 6 adapter packages, workspace globs, TypeScript project references, and old package consumers in `docs/implementation-audits/package-boundary-consolidation-baseline.md`; verify the inventory with `find packages -mindepth 2 -maxdepth 2 -name package.json -print | sort` and the old-package `rg` query from the implementation plan.
- [ ] 1.2 Run `npm run lint`, `npm run build`, `npm test`, and `npm run verify:packages` in the task worktree and record each exit code before any package move; if dependencies are unavailable, record the exact environment failure and prepare the environment before implementation.

## 2. Contracts and plugin package consolidation

- [ ] 2.1 Move `packages/abi/src/*` into `packages/contracts/src/abi/`, re-export the ABI entry from `@iar/contracts`, remove the `@iar/abi` manifest, update all ABI consumers, and verify `npm run lint`, `npm run build`, and the ABI compatibility tests pass.
- [ ] 2.2 Create `packages/plugins` with `sdk/` and `host/` subdirectories, move `plugin-sdk` and `plugin-host` sources into it, expose the former exports from one entry point, update all manifests/imports, and verify plugin installation, lifecycle, and routing tests pass.
- [ ] 2.3 Commit the contracts and plugin consolidation as independently reviewable commits and verify `git status --short` contains only the intended task changes.

## 3. Storage package consolidation

- [ ] 3.1 Move generic storage sources into `packages/storage/src/core/`, persistence SPI into `src/spi/`, persistence runtime into `src/runtime/`, and SQLite provider sources into `src/sqlite/`; preserve the four logical responsibilities and update `packages/storage/src/index.ts` to export all former public symbols.
- [ ] 3.2 Remove the `persistence-spi`, `persistence-runtime`, and `persistence-sqlite` manifests and build configs, replace every `@iar/persistence-*` import with `@iar/storage`, and keep `packages/adapters/postgres` as an independent adapter depending only on `@iar/storage`.
- [ ] 3.3 Run the persistence contract, provider integration, session persistence, and storage replay tests; verify `npm run lint` and `npm run build` pass before committing the storage consolidation.

## 4. Control-plane and observability consolidation

- [ ] 4.1 Move plugin distribution sources under `packages/control-plane/src/distribution/`, move control-plane sources under `src/control-plane/`, expose both through `@iar/control-plane`, remove `@iar/plugin-distribution`, and verify distribution and control-plane tests pass.
- [ ] 4.2 Move observability sources under `packages/observability/src/core/`, move built-in system plugin sources under `src/system-plugin/`, expose both through `@iar/observability`, remove `@iar/built-in-plugins`, and verify the observability security tests pass.
- [ ] 4.3 Run `npm run lint`, `npm run build`, the distribution test group, and `tests/security/observability.test.ts`; commit the control-plane and observability changes only after all focused checks pass.

## 5. Examples and public-consumer boundaries

- [ ] 5.1 Move `examples/fake-plugin`, `examples/human-transfer`, `examples/knowledge-query`, and `examples/ticket-create` under `examples/plugins/`, while keeping `examples/agent-sandbox` at its current root-level location; verify `pnpm-workspace.yaml` still excludes examples from the package globs.
- [ ] 5.2 Replace all example imports that reference deleted package names or `packages/*/src` with public workspace package imports; verify the forbidden-import `rg` query returns no active source or test references.
- [ ] 5.3 Run `npm run demo:fake-plugin` and `npm run demo:sandbox`, update example README paths if needed, and commit the examples reorganization after both demos succeed.

## 6. Workspace, documentation, and final verification

- [ ] 6.1 Update `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.build.json`, `tsconfig.tests.build.json`, and `scripts/verify-package-distribution.mjs` so the final workspace contains 11 core package manifests and 6 adapter package manifests with no deleted package references.
- [ ] 6.2 Update `README.md`, `docs/README.md`, `docs/架构技术方案/README.md`, and `docs/架构技术方案/实现对齐矩阵.md` with the target package map, root-level examples policy, adapter boundary rationale, and future SDK split condition; verify all documented package paths exist.
- [ ] 6.3 Run `npm run lint`, `npm run build`, `npm test`, `npm run verify:packages`, both demos, `openspec validate consolidate-package-boundaries --strict`, and `git diff --check`; record the results in the implementation audit.
- [ ] 6.4 Complete the plan-to-implementation audit, confirm runtime behavior and public symbol names are unchanged, mark this checklist only after all verification commands pass, and prepare the change for archive and merge into `master`.

## Workflow follow-up

- Archive `consolidate-package-boundaries` after implementation, review, verification, and task audit gates pass.
- Merge the task branch into the recorded `master` integration branch with `git merge --no-ff` only after the integration checkout is clean; preserve unrelated web changes.
- Verify the merged ancestry, clean task worktree, and final checkout on `master` before removing the task branch and worktree.
