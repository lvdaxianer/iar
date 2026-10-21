# IAR Runtime Package Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `@iar/runtime` 建立为可独立安装的 IAR 意图/动作运行时，并把只服务运行时主链路的实现收敛为 runtime 内部模块，同时保留 Plugin、持久化、订阅和宿主 adapter 的真实替换边界。

**Architecture:** `@iar/runtime` 成为公开产品入口，内部承载 bootstrap、intent、execution、observability 和 session；`@iar/contracts`、`@iar/plugin`、`@iar/plugins`、`@iar/subscriptions`、`@iar/storage` 保持稳定公共/可替换边界。`@iar/pi-bridge` 只负责 Pi 宿主适配，PostgreSQL、Temporal、HTTP、Sidecar 和隔离执行器继续位于 `packages/adapters/*`。

**Tech Stack:** TypeScript 7、Node.js 24、NodeNext ESM、npm/pnpm workspace、TypeScript project references、Node test runner、OpenSpec、现有 package distribution verifier。

---

## Scope and target package tree

当前仓库实际有 20 个 package manifest：13 个核心包和 7 个 adapter。本计划最终移除 `agent`、`decision`、`rule-engine`、`workflow`、`observability` 五个独立包，把实现移动到 `runtime` 子目录；保留 `contracts`、`plugin`、`plugins`、`subscriptions`、`storage`、`control-plane`、`cli` 以及 7 个 adapter。

```text
packages/
├── contracts/              # @iar/contracts：稳定 JSON 契约和 Schema
├── plugin/                 # @iar/plugin：插件作者 SDK
├── plugins/                # @iar/plugins：PluginHost、FunctionRegistry、生命周期
├── runtime/                # @iar/runtime：独立 IAR 意图/动作运行时
│   └── src/
│       ├── bootstrap/      # 原 agent 装配入口
│       ├── intent/         # 原 decision、rule-engine
│       ├── execution/      # 原 workflow 和动作执行
│       ├── observability/  # 原 observability
│       └── session/        # Context、Replay、Compaction、幂等
├── subscriptions/          # 跨包 Hook/StateEvent 订阅边界
├── storage/                # 持久化 SPI、SQLite 和 runtime loader
├── control-plane/          # 可选租户控制面和插件分发
├── cli/                    # CLI 产品入口
└── adapters/
    ├── pi/                 # @iar/pi-bridge
    ├── fastify/            # HTTP adapter
    ├── service/            # Service API
    ├── sidecar/            # Sidecar transport
    ├── postgres/           # PostgreSQL storage adapter
    ├── temporal/           # Durable workflow adapter
    └── executors/          # worker/sidecar/container executor
```

`@iar/runtime` 独立使用时不要求 Pi、Fastify、PostgreSQL 或 Temporal；持久化、durable execution 和宿主接入由显式 adapter 提供。`@iar/pi-bridge` 不拥有 PluginHost、FunctionRegistry 或 IAR 会话状态。

## Dependency direction

```text
contracts
  ├── plugin ────────┐
  ├── plugins ───────┤
  ├── subscriptions ─┼──→ runtime ───→ control-plane / service / temporal / executors
  └── storage ───────┘        ↑
                              └── pi-bridge 通过协议/HTTP 接入，不反向拥有 runtime
```

实施时不得让 `runtime` 依赖任何 `packages/adapters/*`。`storage` 继续依赖 `subscriptions`，避免基础设施包依赖完整 runtime。

## Task 1: Establish baseline and boundary smoke tests

**Files:**

- Create: `docs/implementation-audits/runtime-package-boundaries-baseline.md`
- Create: `tests/contract/standalone-runtime-entry.test.ts`
- Inspect: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.build.json`
- Inspect: `scripts/verify-package-distribution.mjs`
- Inspect: `packages/*/package.json`, `packages/adapters/*/package.json`

- [ ] **Step 1: Record the current package inventory and dependency graph.**

  Run:

  ```bash
  find packages -mindepth 2 -maxdepth 2 -name package.json -print | sort
  node --input-type=module <<'NODE'
  import fs from 'node:fs';
  import path from 'node:path';
  const roots = ['packages'];
  const manifests = [];
  for (const root of roots) {
    for (const name of fs.readdirSync(root)) {
      const direct = path.join(root, name, 'package.json');
      if (fs.existsSync(direct)) manifests.push(direct);
      const nestedRoot = path.join(root, name);
      if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
        for (const nested of fs.readdirSync(nestedRoot)) {
          const nestedManifest = path.join(nestedRoot, nested, 'package.json');
          if (fs.existsSync(nestedManifest)) manifests.push(nestedManifest);
        }
      }
    }
  }
  for (const file of manifests.sort()) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`${pkg.name}\t${Object.keys(pkg.dependencies ?? {}).join(',') || '-'}`);
  }
  NODE
  ```

  Record the command output in the audit file; do not add a helper script solely for the baseline.

- [ ] **Step 2: Record the clean baseline.**

  Run:

  ```bash
  npm run lint
  npm run build
  npm test
  npm run verify:packages
  ```

  Record exit code, test count, package count, current public entrypoints, and the exact current branch/worktree in `docs/implementation-audits/runtime-package-boundaries-baseline.md`.

- [ ] **Step 3: Write the RED boundary test.**

  The test must import the future public entry and assert the intended observable contract:

  ```ts
  import { createIarRuntime } from '@iar/runtime';

  test('creates a standalone runtime from a valid plugin package', () => {
    const runtime = createIarRuntime({ plugins: [fixturePlugin], decisionProvider });
    assert.equal(runtime.functionRegistry.all().length, 1);
  });
  ```

  Add cases for invalid Plugin rejection without partial state and for a Pi bridge package remaining a separate adapter. Run `npm run build`; it must fail because the new runtime entry is not implemented, not because the test harness is malformed.

- [ ] **Step 4: Commit the baseline task.**

  ```bash
  git add docs/implementation-audits/runtime-package-boundaries-baseline.md tests/contract/standalone-runtime-entry.test.ts
  git commit -m "$(cat <<'EOF'
  📝 docs(架构): 记录运行时包边界迁移基线

  固化当前包清单、依赖方向、发布入口和验证结果，为 runtime 收敛提供可比较基线。

  Refs: OpenSpec runtime-package-boundaries task 1.1
  EOF
  )"
  ```

## Task 2: Create the publishable standalone runtime facade

**Files:**

- Create: `packages/runtime/src/bootstrap/runtime.ts`
- Create: `packages/runtime/src/bootstrap/types.ts`
- Create: `packages/runtime/src/bootstrap/index.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/package.json`
- Modify: `tests/contract/standalone-runtime-entry.test.ts`
- Modify: `tests/contract/unified-agent-entry.test.ts`
- Modify: `scripts/verify-package-distribution.mjs`

- [ ] **Step 1: Define the runtime facade types.**

  `packages/runtime/src/bootstrap/types.ts` must define the public options and result around existing runtime contracts:

  ```ts
  export type IarRuntimeOptions = {
    plugins: readonly PluginPackage[];
    decisionProvider: AsyncDecisionAdapter;
  };

  export type IarRuntime = {
    pluginHost: PluginHost;
    functionRegistry: FunctionRegistry;
    decisionProvider: AsyncDecisionAdapter;
  };
  ```

  Use existing types from `@iar/plugins` and the runtime routing contract; do not duplicate Plugin or Function schemas.

- [ ] **Step 2: Implement atomic initialization.**

  `createIarRuntime` must reuse the existing `PluginHost.installAll`, enable sequence, rollback behavior, and live `FunctionRegistry` binding. It must reject an empty Plugin list and any failed install/enable with the existing stable validation error type. It must not import Pi, Fastify, PostgreSQL, Temporal, or executor modules.

- [ ] **Step 3: Export the facade and migration alias.**

  Export `createIarRuntime`, its types, and a deprecated `createIarAgent` alias from `packages/runtime/src/index.ts`. Keep the alias behaviorally identical during the migration window; the old package name will be removed later.

- [ ] **Step 4: Make runtime publishable.**

  Remove `private: true` from `packages/runtime/package.json`, keep `main`, `types`, `exports`, and `files` pointed at package-local `dist`, and preserve the existing package build layout. Add the runtime project reference only if the current reference graph does not already include it.

- [ ] **Step 5: Verify the facade.**

  Run:

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/contract/standalone-runtime-entry.test.ts tests/contract/unified-agent-entry.test.ts
  npm run verify:packages
  ```

  Expected: the standalone entry, declarations, and packed files pass; the Pi package remains independently importable.

- [ ] **Step 6: Commit the facade task.**

  ```bash
  git add packages/runtime tests/contract scripts/verify-package-distribution.mjs
  git commit -m "$(cat <<'EOF'
  ✨ feat(runtime): 提供独立运行时公共入口

  将 runtime 提升为可安装的 IAR 意图与动作运行时，并保留 agent 初始化语义作为迁移别名。

  Refs: OpenSpec runtime-package-boundaries task 2
  EOF
  )"
  ```

## Task 3: Move decision and rule-engine implementations into runtime

**Files:**

- Move: `packages/decision/src/*` → `packages/runtime/src/intent/decision/`
- Move: `packages/rule-engine/src/*` → `packages/runtime/src/intent/rules/`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/package.json`
- Modify: `tsconfig.build.json`, `tsconfig.json`
- Modify: `tests/routing/decision-provider.test.ts`
- Modify: `tests/routing/two-stage-router.test.ts`
- Modify: `tests/routing/rule-engine.test.ts`
- Modify: `tests/routing/rule-engine-boundaries.test.ts`
- Delete: `packages/decision/package.json`, `packages/decision/tsconfig.build.json`
- Delete: `packages/rule-engine/package.json`, `packages/rule-engine/tsconfig.build.json`

- [ ] **Step 1: Move decision sources without changing exports.**

  Preserve `DecisionBackendResolver`, `IntentModelDecisionAdapter`, `MockDecisionProvider`, model profile types, validation, and gateway behavior. Convert only imports that cross the new runtime directory to relative imports or `@iar/contracts`.

- [ ] **Step 2: Move rule sources without changing candidate semantics.**

  Preserve `RuleEngine`, rule types, evidence, ranking, regex safety, plugin guards, and JSON-safe fact limits. Keep all reject reasons and candidate ordering unchanged.

- [ ] **Step 3: Re-export stable runtime APIs.**

  Add the moved public exports to `packages/runtime/src/index.ts` or a declared runtime subpath, and update runtime-local imports to use those exports only where a package boundary is intended.

- [ ] **Step 4: Update references and remove old packages.**

  Replace active `@iar/decision` and `@iar/rule-engine` imports in packages, tests, examples, scripts, and current docs. Remove their package manifests and project references only after no active source consumer remains.

- [ ] **Step 5: Verify the intent layer.**

  Run:

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/routing/decision-provider.test.ts tests/routing/two-stage-router.test.ts tests/routing/rule-engine.test.ts tests/routing/rule-engine-boundaries.test.ts
  rg -n "@iar/(decision|rule-engine)" packages tests examples scripts README.md docs --glob '!docs/implementation-audits/**' --glob '!docs/架构技术方案/plans/**'
  ```

  Expected: focused tests pass and the active-source search returns no old package imports.

- [ ] **Step 6: Commit the intent consolidation.**

  Use a full Chinese Conventional Commit with `Refs: OpenSpec runtime-package-boundaries task 3`.

## Task 4: Move workflow and observability into runtime

**Files:**

- Move: `packages/workflow/src/*` → `packages/runtime/src/execution/`
- Move: `packages/observability/src/core/*` → `packages/runtime/src/observability/core/`
- Move: `packages/observability/src/system-plugin/*` → `packages/runtime/src/observability/system-plugin/`
- Modify: `packages/runtime/src/index.ts`, `packages/runtime/package.json`
- Modify: `packages/adapters/temporal/package.json`, `packages/adapters/temporal/src/index.ts`
- Modify: `tests/workflow/*.test.ts`, `tests/replay/*.test.ts`, `tests/security/observability.test.ts`
- Delete: `packages/workflow/package.json`, `packages/workflow/tsconfig.build.json`
- Delete: `packages/observability/package.json`, `packages/observability/tsconfig.build.json`

- [ ] **Step 1: Move workflow implementation.**

  Preserve `LocalWorkflow`, `PolicyGate`, `WorkflowEventLog`, confirmation scope hashing, action execution, idempotency, and all existing `WorkflowRequest`/`WorkflowResult` shapes. Resolve old `@iar/runtime` imports as same-package relative imports after the move.

- [ ] **Step 2: Move observability implementation.**

  Preserve recorder fields, redaction limits, system logging Plugin manifest, subscription installation, and fail-open dispatch. Keep `@iar/subscriptions` as the event boundary rather than copying its dispatcher into runtime.

- [ ] **Step 3: Update Temporal and security consumers.**

  Make `@iar/adapters-temporal` depend on `@iar/runtime` for workflow contracts and keep its durable admission semantics unchanged. Update observability tests to import the runtime public observability exports.

- [ ] **Step 4: Verify execution and observability.**

  Run:

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/workflow tests/replay tests/security/observability.test.ts tests/durable
  ```

  Expected: workflow replay, confirmation, durable admission, redaction, and fail-open observability tests pass with no changes to persisted event shapes.

- [ ] **Step 5: Commit the execution and observability consolidation.**

  Use a full Chinese Conventional Commit with `Refs: OpenSpec runtime-package-boundaries task 4`.

## Task 5: Migrate and remove the agent package

**Files:**

- Move/merge: `packages/agent/src/index.ts` → `packages/runtime/src/bootstrap/`
- Modify: `packages/runtime/src/bootstrap/runtime.ts`, `packages/runtime/src/index.ts`
- Modify: `examples/**`, `tests/**`, `scripts/**`
- Modify: `README.md`, `docs/unified-entry.md`, `docs/plugin-function-architecture.md`
- Delete: `packages/agent/package.json`, `packages/agent/tsconfig.build.json`
- Modify: `tsconfig.build.json`, `tsconfig.json`

- [ ] **Step 1: Keep one initialization implementation.**

  Remove duplicate initialization code from the old agent module and make `createIarAgent` only a deprecated runtime alias. Both names must use the same Plugin validation, install ordering, enable rollback, and live registry binding.

- [ ] **Step 2: Migrate active consumers.**

  Replace imports of `createIarAgent` from `@iar/agent` with `createIarRuntime` from `@iar/runtime` in the unified entry test, demos, scripts, examples, and current documentation. Do not change Pi bridge imports.

- [ ] **Step 3: Remove the old package boundary.**

  Delete the agent package manifest and build reference. Keep the alias only in runtime for source-level migration; do not leave an `@iar/agent` package distribution artifact.

- [ ] **Step 4: Verify the migration.**

  Run:

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/contract/unified-agent-entry.test.ts tests/contract/standalone-runtime-entry.test.ts
  rg -n "@iar/agent" packages tests examples scripts README.md docs --glob '!docs/implementation-audits/**' --glob '!docs/架构技术方案/plans/**'
  ```

  Expected: only historical audit/plan documents may contain the old package name; active code and current docs must not.

- [ ] **Step 5: Commit the application-entry migration.**

  Use a full Chinese Conventional Commit with `BREAKING CHANGE: 统一应用入口迁移到 @iar/runtime` and `Refs: OpenSpec runtime-package-boundaries task 5`.

## Task 6: Revalidate control-plane and adapter boundaries

**Files:**

- Modify: `packages/control-plane/package.json`, `packages/control-plane/src/**/*.ts`
- Modify: `packages/adapters/fastify/package.json`, `packages/adapters/service/package.json`, `packages/adapters/sidecar/package.json`
- Modify: `packages/adapters/executors/package.json`, `packages/adapters/executors/src/**/*.ts`
- Modify: `packages/adapters/postgres/package.json`, `packages/adapters/temporal/package.json`
- Preserve: `packages/adapters/pi/package.json`, `packages/adapters/pi/src/**/*.ts`
- Modify: `tests/distribution/*.test.ts`, `tests/security/phase-4-security.test.ts`, `tests/durable/*.test.ts`, Pi bridge tests

- [ ] **Step 1: Update runtime consumers.**

  Replace removed package dependencies with `@iar/runtime` where the adapter consumes routing, workflow, or observability APIs. Keep `@iar/storage` and `@iar/subscriptions` explicit where the adapter consumes persistence or event contracts.

- [ ] **Step 2: Preserve Pi as a protocol adapter.**

  Do not move `packages/adapters/pi` into runtime and do not add PluginHost or session state to the bridge. Verify its `.` and `./pi-extension` exports, `pi.extensions` manifest field, and `iar.pi-bridge/v1` protocol remain unchanged.

- [ ] **Step 3: Enforce dependency direction.**

  Add or update package distribution checks so runtime cannot depend on any `packages/adapters/*`, Postgres/Temporal dependencies cannot appear in runtime, and Postgres continues to depend on storage.

- [ ] **Step 4: Verify adapters.**

  Run:

  ```bash
  npm run lint
  npm run build
  node scripts/run-tests.mjs tests/distribution tests/security/phase-4-security.test.ts tests/durable tests/contract/persistence-provider.test.ts tests/contract/persistence-subscription.test.ts
  npm run verify:packages
  npm run demo:pi-host
  ```

  Expected: distribution, service isolation, durable execution, persistence, and Pi bridge checks pass without protocol changes.

- [ ] **Step 5: Commit the adapter boundary task.**

  Use a full Chinese Conventional Commit with `Refs: OpenSpec runtime-package-boundaries task 6`.

## Task 7: Align current documentation and publish checks

**Files:**

- Modify: `README.md`, `docs/README.md`, `docs/unified-entry.md`
- Modify: `docs/plugin-function-architecture.md`
- Modify: `scripts/verify-package-distribution.mjs`
- Create or modify: `docs/migrations/runtime-package-boundaries.md`
- Preserve as historical: `docs/implementation-audits/**`, archived OpenSpec artifacts, historical architecture plans

- [ ] **Step 1: Document the final package tree.**

  Update current architecture indexes to show `@iar/runtime` as the standalone runtime, `@iar/pi-bridge` as the Pi adapter, and storage/Temporal/Postgres/service packages as adapters. State explicitly that `decision`, `rule-engine`, `workflow`, `observability`, and `agent` are runtime internal modules after migration.

- [ ] **Step 2: Add usage and migration examples.**

  Document:

  ```ts
  import { createIarRuntime } from '@iar/runtime';
  import { definePlugin } from '@iar/plugin';
  ```

  Also document the import mapping from `@iar/agent` to `@iar/runtime`, and explain that Pi continues to install `@iar/pi-bridge` separately.

- [ ] **Step 3: Update package verification.**

  Verify the script checks `@iar/runtime` and `@iar/plugin` compiled entries, declarations, `files` boundaries, declared exports, and absence of removed package artifacts. Ensure historical documents are excluded from active package consumer checks.

- [ ] **Step 4: Verify documentation.**

  Run:

  ```bash
  rg -n "@iar/(agent|decision|rule-engine|workflow|observability)" README.md docs/README.md docs/unified-entry.md docs/plugin-function-architecture.md docs/migrations
  npm run verify:packages
  git diff --check
  ```

  Expected: current docs contain no obsolete package imports, and the migration document contains the complete mapping.

- [ ] **Step 5: Commit documentation and distribution checks.**

  Use a full Chinese Conventional Commit with `Refs: OpenSpec runtime-package-boundaries task 7`.

## Task 8: Full integration verification and audit

**Files:**

- Modify: `docs/implementation-audits/runtime-package-boundaries-baseline.md`
- Verify: all changed package manifests, project references, source imports, tests, examples, and OpenSpec artifacts

- [ ] **Step 1: Validate OpenSpec and source consistency.**

  Run:

  ```bash
  openspec validate runtime-package-boundaries --strict
  git diff --check
  rg -n "@iar/(agent|decision|rule-engine|workflow|observability)" packages tests examples scripts README.md docs --glob '!docs/implementation-audits/**' --glob '!docs/架构技术方案/plans/**' --glob '!openspec/changes/archive/**'
  ```

  Expected: strict validation passes, diff check is clean, and no removed package is an active consumer.

- [ ] **Step 2: Run the full verification matrix.**

  Run:

  ```bash
  npm run lint
  npm run build
  npm test
  npm run verify:packages
  npm run demo:fake-plugin
  npm run demo:sandbox -- --brain scripted
  npm run demo:pi-host
  ```

  Record command results, package count, and test count in the implementation audit. The audit must explicitly cover standalone runtime initialization, routing behavior, persistence boundaries, Pi behavior, and adapter dependency direction.

- [ ] **Step 3: Complete final review and task audit.**

  Compare the implementation against `openspec/changes/runtime-package-boundaries/proposal.md`, `design.md`, both delta specs, and this plan. List completed and unfinished tasks; do not mark the change complete if any package migration, active import cleanup, or verification evidence is missing.

- [ ] **Step 4: Commit the final audit.**

  Use a full Chinese Conventional Commit with `Refs: OpenSpec runtime-package-boundaries task 8`.

## Workflow follow-up

- After all implementation tasks pass their per-task review and verification gates, archive the OpenSpec change with the repository archive workflow.
- Merge the task branch back into the confirmed `master` integration branch only after the integration checkout is clean and the branch contains all task commits.
- Remove the dedicated worktree after successful merge; preserve historical audit and archived OpenSpec records.
