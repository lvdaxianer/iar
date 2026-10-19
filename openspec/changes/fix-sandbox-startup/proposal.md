# Proposal

## Why

`pnpm run demo:sandbox` currently performs an implicit dependency installation before running the script. In this repository that installation can time out on the public registry or incorrectly resolve private local `@iar/*` packages from npm. When a previous sandbox process still owns port 8787, the sanitized startup log also hides the actionable cause.

## What Changes

- Declare the pnpm workspace and local-package linking policy explicitly.
- Prevent `pnpm run` from implicitly installing dependencies before a demo script.
- Report port collisions as a safe, actionable startup failure category.
- Add regression coverage and document the supported startup commands.

## Capabilities

### New Capabilities

- `sandbox-startup`: Provides predictable local sandbox startup and actionable, non-sensitive startup diagnostics.

### Modified Capabilities

None.

## Impact

- Root package-manager configuration and workspace metadata.
- `scripts/run-agent-sandbox.mjs` and sandbox safe-log allowlists.
- Agent sandbox startup tests and documentation.
- No runtime business routing, session, persistence, or model contract changes.
