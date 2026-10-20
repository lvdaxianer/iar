# Standardize Package Build Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有 IAR Node 包统一为可独立构建、可独立打包、可独立消费的 `src → dist` 发布结构，并移除根级 `../../dist` 入口耦合。

**Architecture:** 每个包以自身 `src` 为 rootDir、以自身 `dist` 为 outDir；根级 `tsc -b` 仅负责按 Project References 编排构建。包间使用 `@iar/*` 公共边界，包内保留 NodeNext 所需的 `.js` 相对导入，`exports` 和 `types` 只指向包内构建产物。

**Tech Stack:** Node.js ESM, TypeScript NodeNext, TypeScript Project References, npm/pnpm workspaces, Node test runner。

---

### Task 1: Establish package build baseline

**Files:**
- Create: `tsconfig.base.json`
- Create: each package's `tsconfig.build.json`
- Modify: `tsconfig.json`, `package.json`
- Test: root build/typecheck commands

- [ ] **Step 1: Add shared compiler settings and package build configs**

  Set package `rootDir` to `src`, package `outDir` to `dist`, preserve NodeNext ESM, emit declarations and source maps, and enable project references where dependencies exist.

- [ ] **Step 2: Add root build orchestration**

  Replace the single root emit with `tsc -b` references and keep a separate no-emit typecheck command.

- [ ] **Step 3: Run RED baseline checks**

  Run `npm run build` and `npm run lint` before package migration; record the current failure caused by old package layout so the new checks prove the migration.

- [ ] **Step 4: Build the foundation package set**

  Compile `contracts`, `abi`, `plugin-sdk`, `persistence-spi`, and `subscriptions` into their package-local `dist` directories.

- [ ] **Step 5: Verify GREEN**

  Run `npm run build`, verify each foundation package has `dist/index.js` and `dist/index.d.ts`, then run `npm run lint`.

- [ ] **Step 6: Commit the baseline and planning assets**

  Commit the OpenSpec assets, implementation plan, compiler configuration, and foundation build changes as one atomic task.

### Task 2: Standardize package metadata and entrypoints

**Files:**
- Modify: all `packages/*/package.json` and `packages/adapters/*/package.json`
- Delete: package-root `index.js` forwarding files after their package is migrated
- Test: package export and declaration checks

- [ ] **Step 1: Define package metadata contract**

  Set `main` and `exports.import` to `./dist/index.js`, `types`/`exports.types` to `./dist/index.d.ts`, and `files` to `dist`; retain existing `private` values until a release decision.

- [ ] **Step 2: Migrate public subpath exports**

  Preserve only existing supported subpaths such as `@iar/adapters-fastify/http-boundary`, mapping them to package-local `dist` files.

- [ ] **Step 3: Remove forwarding entrypoints package by package**

  Delete the root `index.js` shim only after the corresponding package metadata points to an existing local build artifact.

- [ ] **Step 4: Verify package boundaries**

  Run a script that parses every package manifest, checks all export targets and declaration targets exist, and rejects `src`/root-`dist` targets.

### Task 3: Migrate core and adapter packages

**Files:**
- Modify: `packages/*/src/**/*.ts`, `packages/adapters/*/src/**/*.ts`
- Modify: package-local build configs and manifests
- Test: focused package tests and full typecheck

- [ ] **Step 1: Replace cross-package source paths**

  Convert every cross-package import to its `@iar/*` package name; keep same-package imports as `./module.js`.

- [ ] **Step 2: Migrate core packages**

  Migrate decision, rule-engine, plugin-host, runtime, workflow, control-plane, storage, persistence-runtime, persistence-sqlite, observability, built-in-plugins, and plugin-distribution.

- [ ] **Step 3: Migrate adapters and CLI**

  Migrate executors, fastify, postgres, service, sidecar, temporal, and cli; preserve public subpaths and external Node dependencies.

- [ ] **Step 4: Verify Worker and dynamic Provider behavior**

  Build and run tests covering SQLite Worker startup, `new URL('./worker.js', import.meta.url)`, Provider loading, and Fastify/adapter entrypoints.

### Task 4: Update tests, demos, and publish verification

**Files:**
- Modify: `scripts/run-tests.mjs`, `scripts/run-fake-plugin-demo.mjs`, `scripts/run-agent-sandbox.mjs`
- Create: `scripts/verify-package-artifacts.mjs`
- Modify: relevant `tests/**/*.ts`

- [ ] **Step 1: Remove root dist assumptions**

  Update scripts and tests to consume package public entrypoints or package-local build artifacts instead of `dist/packages/**`.

- [ ] **Step 2: Add package artifact verification**

  Check `exports`, `types`, `files`, existing JavaScript/declaration files, and public importability; exit non-zero for any missing or undeclared artifact.

- [ ] **Step 3: Add tarball smoke verification**

  Build one representative package, run `npm pack --dry-run`, install or import the tarball from a temporary directory, and verify no repository source or root dist is required.

- [ ] **Step 4: Run the complete test suite**

  Run `npm run build`, `npm run lint`, `npm test`, the two demos, artifact verification, and targeted package tests.

### Task 5: Update repository hygiene

**Files:**
- Modify: `.gitignore`
- Test: `git check-ignore`, `git ls-files`, package tarball checks

- [ ] **Step 1: Add local AI directories to the managed ignore block**

  Add `.agents/` and `.claude/` without removing or untracking existing files.

- [ ] **Step 2: Verify tracked-file preservation**

  Confirm existing tracked `.agents`/`.claude` files remain in `git ls-files`, while a new probe file under each directory is ignored.

- [ ] **Step 3: Verify dist policy**

  Confirm `dist/` is ignored by Git and included by `npm pack --dry-run` for each publishable package.

### Task 6: Final audit and integration

**Files:**
- Review all changed files and OpenSpec artifacts

- [ ] **Step 1: Run strict validation and consistency audit**

  Run `openspec validate standardize-package-build-layout --strict`, inspect the diff against proposal/spec/design/tasks, and fix any uncovered requirement.

- [ ] **Step 2: Run final clean-build verification**

  From a clean task worktree, remove generated output, run the full build/typecheck/test/package checks, and record results.

- [ ] **Step 3: Merge only after gates pass**

  Return to clean `master`, preserve unrelated user changes, merge the task branch, verify ancestry and final status, then archive the completed OpenSpec change.
