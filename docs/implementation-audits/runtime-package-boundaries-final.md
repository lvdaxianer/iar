# Runtime package boundaries final audit

## Scope

This audit closes the `runtime-package-boundaries` change. The final workspace
contains eight core packages and seven optional adapters. The implementation
branch has no active import from the removed `@iar/agent`, `@iar/decision`,
`@iar/rule-engine`, `@iar/workflow`, or `@iar/observability` packages.

## Integration gates

The following gates passed on 2026-10-21 in the implementation worktree:

| Gate | Result | Evidence |
| --- | --- | --- |
| `openspec validate runtime-package-boundaries --strict` | pass | strict change validation completed before the final audit |
| `git diff --check` | pass | no whitespace errors |
| `npm run lint` | pass | TypeScript project type-check completed |
| `npm run build` | pass | production and test declarations compiled |
| `npm test` | pass | full test runner completed with exit code 0; no failed tests |
| `npm run verify:packages` | pass | 15 package distributions and root-entry consumer smoke checks passed |

The package verifier confirms that `@iar/runtime` is publishable, its root
entry resolves compiled JavaScript and declarations, and the tarballs contain
only `package.json` and `dist/**`. It also rejects the five removed package
manifests, runtime-to-adapter dependencies, and Pi dependencies in the runtime.

## Demo gates

All three requested demos passed with the offline scripted brain:

- `npm run demo:fake-plugin` exited 0 and printed the full lifecycle
  (`discovered`, `validated`, `installed`, `enabled`, `disabled`, `unloaded`)
  plus the replayed final event.
- `IAR_SANDBOX_PORT=18787 npm run demo:sandbox -- --brain scripted` exited 0
  after the sandbox emitted its controlled startup record and accepted SIGINT.
- `IAR_SANDBOX_PORT=18787 IAR_PI_HOST_PORT=18788 npm run demo:pi-host --
  --brain scripted` exited 0 after the Pi host and bridge started together and
  accepted SIGINT. The default 8787 port was already occupied, so explicit
  isolated demo ports were used; the default collision path also returned the
  expected controlled failure classification.

## Architecture review

The final dependency direction is:

```text
contracts / plugin / plugins / subscriptions / storage
                         ↓
                      runtime
                         ↓
              control-plane and adapters
```

`@iar/runtime` owns the standalone intent/action runtime: bootstrap, bounded
decision and rule evaluation, routing, execution, observability, replay,
compaction and session state. Its runtime dependencies are limited to
`@iar/contracts`, `@iar/plugins` and `@iar/subscriptions`.

`@iar/pi-bridge` remains the Pi host/protocol adapter and has no runtime
implementation ownership. `@iar/storage` remains the persistence SPI and
SQLite implementation; PostgreSQL is supplied by `@iar/adapters-postgres`.
Temporal, Fastify, service, sidecar and isolated executors remain adapters.
None of Pi, HTTP, PostgreSQL, Temporal or container dependencies enters the
runtime core.

The public package map and migration table are documented in
`docs/runtime-package-migration.md`; the root runtime entry is
`packages/runtime/src/bootstrap/runtime.ts`. The design non-goals remain
unchanged: no new Pi/API/database/Temporal semantics, no remote Handler
protocol, no change to Plugin > Function > Operation, and no removal of
control-plane or adapter packages.

## Decision

All implementation, validation, demo and architecture gates passed. The
OpenSpec change is ready for archive and the branch is ready to merge into
`master`.
