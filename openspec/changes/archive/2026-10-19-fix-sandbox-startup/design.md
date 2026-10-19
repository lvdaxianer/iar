# Design

## Context

The repository currently has an npm lockfile and npm workspace metadata in `package.json`, while pnpm creates a workspace file on demand. Internal package dependencies use the shared `0.1.0` version, so pnpm needs an explicit local-linking policy. The launcher intentionally redacts raw startup exceptions, but the current generic category does not distinguish a port collision from other startup failures.

## Goals / Non-Goals

**Goals:**

- Make pnpm invocation deterministic for the existing local workspace and installed dependencies.
- Keep network installation out of the `pnpm run` execution path.
- Preserve the safe logging boundary while making port collisions actionable.
- Keep npm as the documented default because the repository already uses `package-lock.json`.

**Non-Goals:**

- Do not change the default port, automatically kill another process, or silently select a random port.
- Do not change model configuration, session behavior, structured context, or plugin routing.
- Do not add a pnpm lockfile or change package dependency ranges in this bug fix.

## Decisions

1. **Commit explicit pnpm metadata.** Add `pnpm-workspace.yaml` with the existing workspace globs and `linkWorkspacePackages: true`; add `.npmrc` settings for local workspace linking and `verify-deps-before-run=false`. This prevents the observed registry lookup for private local packages and avoids an implicit network install during script execution.
2. **Keep the launcher fail-closed.** Add a small pure classifier for `EADDRINUSE`; the safe log receives only the fixed enum `port_in_use`, and stderr receives a fixed Chinese recovery hint. Raw errors remain excluded.
3. **Test through the existing startup subprocess path.** Extend the existing safe startup integration test to occupy a local port, invoke the launcher, and assert the safe event and hint. Add a configuration regression test for the explicit pnpm workspace settings.

## Risks / Trade-offs

- [Risk] Skipping automatic dependency verification can allow stale `node_modules` to reach the script. → Mitigation: keep explicit `npm install`/`pnpm install` as the setup step and document that the run command assumes dependencies are prepared.
- [Risk] A fixed `port_in_use` category does not identify which process owns the port. → Mitigation: the hint directs the user to `lsof` and supports `IAR_SANDBOX_PORT`; no process is killed automatically.

## Migration Plan

Existing checkouts can keep using `npm run demo:sandbox`. pnpm users should run an explicit dependency installation once, then rerun the demo. No data migration or service restart is required by this change.
