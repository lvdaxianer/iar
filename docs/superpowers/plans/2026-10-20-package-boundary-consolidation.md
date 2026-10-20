# Package Boundary Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 IAR 的内部 workspace 包从“每个逻辑模块一个包”收敛为稳定的发布/部署边界，同时保持运行时行为不变。

**Architecture:** 保留 `runtime`、`workflow`、`decision`、`rule-engine` 等核心职责的逻辑边界，但把当前没有独立发布需求的契约、插件、持久化、控制面和观测实现合并为包内子目录。适配器仍作为独立可选依赖包，`examples` 位于仓库根目录并只通过公开包入口消费能力。

**Tech Stack:** TypeScript 7、Node.js 24、npm/pnpm workspace、Node test runner、OpenSpec、现有 TypeScript project references。

---

## Working Rules

- 所有修改、测试和提交在专用 worktree `features/✅CHG-003-T1--包边界收敛计划` 中完成。
- 集成分支固定为 `master`；不要触碰主 worktree 中已有的 `examples/agent-sandbox/web/*` 改动。
- 每个任务独立提交；任务完成前必须通过该任务的聚焦检查和全量相关检查。
- 本次只移动包边界和 import，不修改运行时语义、契约字段、错误码、持久化格式或测试意图。

### Task 1: 建立包和引用基线

**Files:**
- Create: `docs/implementation-audits/package-boundary-consolidation-baseline.md`
- Inspect: `package.json`
- Inspect: `pnpm-workspace.yaml`
- Inspect: `tsconfig.json`
- Inspect: `tsconfig.build.json`
- Inspect: `scripts/verify-package-distribution.mjs`
- Inspect: `packages/*/package.json`
- Inspect: `packages/adapters/*/package.json`
- Inspect: `tests/**`
- Inspect: `examples/**`

- [ ] **Step 1: Record the current workspace package inventory.**

  Run:

  ```bash
  find packages -mindepth 2 -maxdepth 2 -name package.json -print | sort
  ```

  Record the 18 core packages and 6 adapter packages in the baseline audit. Record that all internal packages currently use `private: true`.

- [ ] **Step 2: Record every old package consumer.**

  Run:

  ```bash
  rg -n --hidden -g '!dist/**' -g '!node_modules/**' \
    '@iar/(abi|built-in-plugins|observability|persistence-runtime|persistence-spi|persistence-sqlite|plugin-distribution|plugin-host|plugin-sdk|storage)' \
    packages tests examples scripts docs README.md
  ```

  Group each result under the target package mapping: `contracts`, `plugins`, `control-plane`, `storage`, or `observability`. Do not edit consumers in this task.

- [ ] **Step 3: Record the baseline verification state.**

  Run:

  ```bash
  npm run lint
  npm run build
  npm test
  npm run verify:packages
  ```

  Record exit codes and test counts. If dependencies are unavailable, record the exact missing dependency condition and stop implementation until the environment is prepared.

- [ ] **Step 4: Commit the baseline audit.**

  ```bash
  git add docs/implementation-audits/package-boundary-consolidation-baseline.md
  git commit -m "docs(architecture): record package boundary baseline"
  ```

- [ ] **Step 5: Add the target package boundary smoke test and verify RED.**

  Add `tests/contract/package-boundaries.test.ts` importing the former public ABI, plugin, persistence, distribution, and system-plugin symbols from their target package roots. Run:

  ```bash
  npm run build
  ```

  Expected: FAIL because `@iar/plugins` does not exist yet and the other target entries do not export all former symbols. The failure must be a missing target package/export diagnostic, not a syntax or test setup error.

### Task 2: Merge ABI into contracts

**Files:**
- Move: `packages/abi/src/types.ts` → `packages/contracts/src/abi/types.ts`
- Move: `packages/abi/src/validation.ts` → `packages/contracts/src/abi/validation.ts`
- Move: `packages/abi/src/index.ts` → `packages/contracts/src/abi/index.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`
- Delete: `packages/abi/package.json`
- Delete: `packages/abi/tsconfig.build.json`
- Modify: `packages/control-plane/src/control-plane.ts`
- Modify: `packages/control-plane/src/types.ts`
- Modify: `tests/compatibility/abi-compatibility.test.ts`
- Modify: `tests/compatibility/phase-5-failure-drills.test.ts`

- [ ] **Step 1: Move ABI sources under the contracts package.** Preserve all exported symbols and change only the relative imports required by the new `contracts/src/abi/` location.

- [ ] **Step 2: Re-export ABI from the contracts entry point.** Add `export * from './abi/index.js';` to `packages/contracts/src/index.ts`. Keep the existing contracts exports unchanged.

- [ ] **Step 3: Remove the ABI workspace dependency edge.** Remove the `packages/abi` manifest and build config, remove `@iar/abi` from `control-plane/package.json`, and replace source/test imports with `@iar/contracts`.

- [ ] **Step 4: Verify the focused ABI boundary.**

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/compatibility/abi-compatibility.test.ts tests/compatibility/phase-5-failure-drills.test.ts
  ```

- [ ] **Step 5: Commit the ABI consolidation.**

  ```bash
  git add packages/contracts packages/control-plane packages/abi tests/compatibility
  git commit -m "refactor(contracts): fold abi into contracts package"
  ```

### Task 3: Merge plugin SDK and host

**Files:**
- Move: `packages/plugin-sdk/src/index.ts` → `packages/plugins/src/sdk/index.ts`
- Move: `packages/plugin-host/src/*.ts` → `packages/plugins/src/host/`
- Create: `packages/plugins/package.json`
- Create: `packages/plugins/tsconfig.build.json`
- Create: `packages/plugins/src/index.ts`
- Delete: `packages/plugin-sdk/package.json`
- Delete: `packages/plugin-sdk/tsconfig.build.json`
- Delete: `packages/plugin-host/package.json`
- Delete: `packages/plugin-host/tsconfig.build.json`
- Modify: `packages/runtime/package.json`
- Modify: `packages/control-plane/package.json`
- Modify: `packages/adapters/fastify/package.json`
- Modify: `packages/adapters/service/package.json`
- Modify: `packages/adapters/executors/package.json`
- Modify: `packages/adapters/sidecar/package.json`
- Modify: `packages/runtime/src/routing.ts`
- Modify: `packages/control-plane/src/control-plane.ts`
- Modify: all tests and examples importing `@iar/plugin-host` or `@iar/plugin-sdk`

- [ ] **Step 1: Create the combined plugin package with one public entry.** The new entry must re-export the former SDK and Host exports without changing names or types.

- [ ] **Step 2: Move host and SDK imports to `@iar/plugins`.** Replace all workspace manifest dependencies and source/test/example imports. Keep internal imports between `sdk/` and `host/` relative to the combined package.

- [ ] **Step 3: Verify plugin lifecycle and routing behavior.**

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs \
    tests/contract/plugin-installation.test.ts \
    tests/contract/plugin-installation-boundaries.test.ts \
    tests/contract/plugin-lifecycle.test.ts \
    tests/routing/two-stage-router.test.ts \
    tests/routing/scoped-plugin-routing.test.ts
  ```

- [ ] **Step 4: Commit the plugin consolidation.**

  ```bash
  git add packages/plugins packages/plugin-sdk packages/plugin-host packages/runtime packages/control-plane packages/adapters tests examples
  git commit -m "refactor(plugins): consolidate sdk and host package"
  ```

### Task 4: Merge storage and persistence packages

**Files:**
- Move: `packages/storage/src/*.ts` → `packages/storage/src/core/`
- Move: `packages/persistence-spi/src/*.ts` → `packages/storage/src/spi/`
- Move: `packages/persistence-runtime/src/*.ts` → `packages/storage/src/runtime/`
- Move: `packages/persistence-sqlite/src/*.ts` → `packages/storage/src/sqlite/`
- Modify: `packages/storage/src/index.ts`
- Modify: `packages/storage/package.json`
- Delete: `packages/persistence-spi/package.json`
- Delete: `packages/persistence-spi/tsconfig.build.json`
- Delete: `packages/persistence-runtime/package.json`
- Delete: `packages/persistence-runtime/tsconfig.build.json`
- Delete: `packages/persistence-sqlite/package.json`
- Delete: `packages/persistence-sqlite/tsconfig.build.json`
- Modify: `examples/agent-sandbox/src/**`
- Modify: `tests/contract/persistence-provider.test.ts`
- Modify: `tests/contract/persistence-subscription.test.ts`
- Modify: `tests/integration/persistence-provider.test.ts`
- Modify: `tests/integration/agent-sandbox/session-*.test.ts`
- Modify: `tests/replay/storage-*.test.ts`

- [ ] **Step 1: Preserve the four storage responsibilities as subdirectories.** Keep generic stores under `core/`, provider contracts under `spi/`, loader/registry/subscriber logic under `runtime/`, and SQLite implementation under `sqlite/`.

- [ ] **Step 2: Expose the former public symbols through `@iar/storage`.** Update `packages/storage/src/index.ts` so existing storage and provider symbols remain available from one package entry.

- [ ] **Step 3: Replace persistence package imports and manifest dependencies.** Remove the three persistence package manifests and replace all `@iar/persistence-*` imports with `@iar/storage`.

- [ ] **Step 4: Keep PostgreSQL as an adapter.** Do not move `packages/adapters/postgres`; it must continue depending on `@iar/storage` and must not add PostgreSQL dependencies to the core storage package.

- [ ] **Step 5: Verify persistence contracts and recovery behavior.**

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs \
    tests/contract/persistence-provider.test.ts \
    tests/contract/persistence-subscription.test.ts \
    tests/integration/persistence-provider.test.ts \
    tests/integration/agent-sandbox/session-persistence.test.ts \
    tests/replay/storage-reopen.test.ts \
    tests/replay/storage-runtime.test.ts
  ```

- [ ] **Step 6: Commit the storage consolidation.**

  ```bash
  git add packages/storage packages/persistence-spi packages/persistence-runtime packages/persistence-sqlite packages/adapters/postgres examples tests
  git commit -m "refactor(storage): consolidate persistence package boundaries"
  ```

### Task 5: Merge control-plane distribution and observability system plugin

**Files:**
- Move: `packages/plugin-distribution/src/*.ts` → `packages/control-plane/src/distribution/`
- Move: `packages/control-plane/src/*.ts` → `packages/control-plane/src/control-plane/`
- Move: `packages/observability/src/*.ts` → `packages/observability/src/core/`
- Move: `packages/built-in-plugins/src/*.ts` → `packages/observability/src/system-plugin/`
- Create or update: `packages/control-plane/src/index.ts`
- Create or update: `packages/observability/src/index.ts`
- Modify: `packages/control-plane/package.json`
- Modify: `packages/observability/package.json`
- Delete: `packages/plugin-distribution/package.json`
- Delete: `packages/plugin-distribution/tsconfig.build.json`
- Delete: `packages/built-in-plugins/package.json`
- Delete: `packages/built-in-plugins/tsconfig.build.json`
- Modify: `tests/distribution/*.test.ts`
- Modify: `tests/compatibility/phase-5-failure-drills.test.ts`
- Modify: `tests/security/observability.test.ts`

- [ ] **Step 1: Consolidate distribution behind the control-plane entry.** Re-export distribution types and operations from `@iar/control-plane`, remove the `@iar/plugin-distribution` dependency edge, and preserve signed install/upgrade/rollback behavior.

- [ ] **Step 2: Consolidate the system logging plugin behind observability.** Re-export system plugin manifest, factory, installation helper, recorder and redaction symbols from `@iar/observability`, remove the `@iar/built-in-plugins` dependency edge, and preserve fail-open subscription behavior.

- [ ] **Step 3: Verify focused distribution and observability tests.**

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs \
    tests/distribution/plugin-distribution.test.ts \
    tests/distribution/control-plane.test.ts \
    tests/distribution/phase-5-failure-drills.test.ts \
    tests/security/observability.test.ts
  ```

- [ ] **Step 4: Commit the control-plane and observability consolidation.**

  ```bash
  git add packages/control-plane packages/plugin-distribution packages/observability packages/built-in-plugins tests
  git commit -m "refactor(platform): consolidate control plane and observability packages"
  ```

### Task 6: Reorganize examples as package consumers

**Files:**
- Move: `examples/fake-plugin/` → `examples/plugins/fake-plugin/`
- Move: `examples/human-transfer/` → `examples/plugins/human-transfer/`
- Move: `examples/knowledge-query/` → `examples/plugins/knowledge-query/`
- Move: `examples/ticket-create/` → `examples/plugins/ticket-create/`
- Keep: `examples/agent-sandbox/`
- Modify: example README files and source imports
- Modify: `scripts/run-fake-plugin-demo.mjs`
- Modify: `scripts/run-agent-sandbox.mjs`
- Modify: `README.md`

- [ ] **Step 1: Move only plugin examples under `examples/plugins/`.** Do not move `agent-sandbox` and do not add `examples` to the `packages/*` workspace glob.

- [ ] **Step 2: Replace example imports with public package entries.** Use `@iar/contracts`, `@iar/plugins`, `@iar/runtime`, `@iar/storage`, `@iar/observability` and other package roots as appropriate; no example may import from `packages/*/src`.

- [ ] **Step 3: Verify both demos.**

  ```bash
  npm run demo:fake-plugin
  npm run demo:sandbox
  ```

- [ ] **Step 4: Commit the examples reorganization.**

  ```bash
  git add examples scripts README.md
  git commit -m "refactor(examples): organize examples as package consumers"
  ```

### Task 7: Clean workspace manifests, documentation, and final verification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `tsconfig.json`
- Modify: `tsconfig.build.json`
- Modify: `tsconfig.tests.build.json`
- Modify: `scripts/verify-package-distribution.mjs`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/架构技术方案/README.md`
- Modify: `docs/架构技术方案/实现对齐矩阵.md`
- Modify: `openspec/changes/consolidate-package-boundaries/tasks.md`

- [ ] **Step 1: Remove deleted package references from workspace and build configuration.** The final workspace must contain 11 core package manifests and 6 adapter package manifests; no deleted package path may remain in TypeScript project references or distribution verification.

- [ ] **Step 2: Update architecture documentation.** Document the target package map, the root-level `examples` policy, the reason adapters remain independent, and the future condition for splitting `plugin-sdk` again.

- [ ] **Step 3: Search for stale package names and internal source imports.**

  ```bash
  rg -n --hidden -g '!dist/**' -g '!node_modules/**' \
    '@iar/(abi|built-in-plugins|persistence-runtime|persistence-spi|persistence-sqlite|plugin-distribution|plugin-host|plugin-sdk)' \
    packages tests examples scripts docs README.md

  rg -n --hidden -g '!dist/**' -g '!node_modules/**' \
    'packages/.*/src|\.\./\.\./packages/' \
    examples tests scripts
  ```

  Both searches must return no active source or test references; historical plan/audit text may be retained when it explicitly describes the migration.

- [ ] **Step 4: Run the full verification suite.**

  ```bash
  npm run lint
  npm run build
  npm test
  npm run verify:packages
  npm run demo:fake-plugin
  npm run demo:sandbox
  openspec validate consolidate-package-boundaries --strict
  git diff --check
  ```

- [ ] **Step 5: Perform the final plan/code audit.** Confirm that no source behavior changed, every target package has one public entry, every adapter remains optional, examples consume public APIs, and the final package count matches the target map.

- [ ] **Step 6: Commit the final cleanup and OpenSpec archive preparation.**

  ```bash
  git add package.json pnpm-workspace.yaml tsconfig*.json scripts docs README.md openspec/changes/consolidate-package-boundaries
  git commit -m "docs(architecture): finalize package boundary consolidation plan"
  ```

## Final Integration

After all tasks pass their focused and full verification gates, merge the task branch into the recorded `master` integration branch with `--no-ff`. Preserve the unrelated web changes in the original checkout, verify the merge ancestry, and only then remove the task worktree and branch.
