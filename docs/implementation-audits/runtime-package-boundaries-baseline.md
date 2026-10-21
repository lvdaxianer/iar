# Runtime package boundaries baseline

## Scope

- Branch: `features/✅CHG-004-T2--运行时包边界迁移`
- Worktree: `/Users/lvdaxianer/workspace/my/project/iar/.Codex/worktrees/features/✅CHG-004-T2--运行时包边界迁移`
- Baseline date: 2026-10-21
- Source branch: `master`

The repository currently contains 20 package manifests: 13 core packages and 7 adapter packages.

## Current package inventory and dependency graph

The inventory was generated from `packages/**/package.json` and includes runtime dependencies only:

```text
@iar/adapters-executors   -> @iar/contracts, @iar/plugins, @iar/subscriptions
@iar/adapters-fastify     -> @iar/contracts, @iar/plugins, @iar/workflow, fastify
@iar/pi-bridge            -> -
@iar/adapters-postgres    -> @iar/storage
@iar/adapters-service     -> @iar/adapters-fastify, @iar/contracts, @iar/plugins, @iar/runtime, @iar/storage
@iar/adapters-sidecar     -> @iar/adapters-service
@iar/adapters-temporal    -> @iar/workflow
@iar/agent                -> @iar/contracts, @iar/plugins
@iar/cli                  -> @iar/adapters-service
@iar/contracts            -> @sinclair/typebox, ajv
@iar/control-plane        -> @iar/contracts, @iar/plugins
@iar/decision             -> @iar/contracts
@iar/observability        -> @iar/contracts, @iar/subscriptions
@iar/plugin               -> @iar/contracts, @iar/plugins
@iar/plugins              -> @iar/contracts
@iar/rule-engine          -> @iar/contracts
@iar/runtime              -> @iar/contracts, @iar/decision, @iar/plugins, @iar/rule-engine
@iar/storage              -> @iar/contracts, @iar/subscriptions
@iar/subscriptions        -> @iar/contracts
@iar/workflow             -> @iar/contracts, @iar/runtime
```

All packages currently declare `./dist/index.js` and `./dist/index.d.ts` as their root entry. The packages with additional declared subpaths are:

- `@iar/adapters-fastify`: `./http-boundary`
- `@iar/pi-bridge`: `./pi-extension`

The current TypeScript build graph contains separate project references for `agent`, `decision`, `observability`, `rule-engine`, `runtime`, and `workflow`, in addition to the retained packages and adapters.

## Baseline commands

Commands were run from the worktree above:

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | pass | exit code 0 |
| `npm run build` | pass | exit code 0 |
| `npm test` | pass | exit code 0; all discovered test processes reported zero failures |
| `npm run verify:packages` | pass after verifier harness correction | all 20 package tarballs, root imports, and the temporary `@iar/contracts` tarball consumer passed |

The package verifier reached these checks before the existing environment-sensitive failure:

```text
verified @iar/agent
verified @iar/cli
verified @iar/contracts
verified @iar/control-plane
verified @iar/decision
verified @iar/observability
verified @iar/plugin
verified @iar/plugins
verified @iar/rule-engine
verified @iar/runtime
verified @iar/storage
verified @iar/subscriptions
verified @iar/workflow
verified @iar/adapters-executors
verified @iar/adapters-fastify
verified @iar/pi-bridge
verified @iar/adapters-postgres
verified @iar/adapters-service
verified @iar/adapters-sidecar
verified @iar/adapters-temporal
```

The first baseline attempt exposed an environment coupling in the verifier's temporary consumer setup, not in a package tarball or package-root import:

```text
Error: Command failed: npm install --offline ... iar-contracts-0.1.0.tgz
scripts/verify-package-distribution.mjs:99
```

The verifier now extracts the local tarball directly into a temporary `node_modules` tree and links already-installed third-party dependencies, avoiding both an unavailable npm offline registry cache and the worktree's intentionally absent local `node_modules`. Its package count remains 20 until the planned package consolidation updates it, and the final check will also validate both public authoring/runtime entries.

## Boundary observations

- `@iar/runtime` is currently private and still depends on the soon-to-be-consolidated `@iar/decision` and `@iar/rule-engine` packages.
- `@iar/agent` owns the atomic PluginHost/FunctionRegistry bootstrap but is not a standalone runtime package.
- `@iar/pi-bridge` has no runtime implementation dependency and already exposes its own protocol/extension boundary.
- Persistence is already separated as `@iar/storage` plus `@iar/adapters-postgres`; durable workflow is currently exposed through `@iar/workflow` plus `@iar/adapters-temporal`.
- The current source boundary therefore contains several implementation packages that can be moved behind the public runtime entry without changing the replacement boundaries for Plugin, storage, subscriptions, or host adapters.
