# Tasks

## 1. Startup reliability

- [x] 1.1 Add failing regression coverage for occupied-port diagnostics and explicit pnpm workspace settings; verify the focused tests fail for the missing behavior.
- [x] 1.2 Add explicit pnpm workspace/linking configuration and disable implicit dependency installation; verify pnpm configuration resolves local package metadata without invoking the registry during `pnpm run`.
- [x] 1.3 Classify `EADDRINUSE` as `port_in_use` and emit a safe recovery hint; verify the startup integration test passes without leaking raw errors.
- [x] 1.4 Update sandbox startup documentation with npm/pnpm setup and port recovery commands; verify every documented command is consistent with the launcher behavior.

## Workflow follow-up

- Run the focused and broader verification gates, complete review and audit, then merge this task branch into `master`.
- Archive the completed OpenSpec change after integration.
