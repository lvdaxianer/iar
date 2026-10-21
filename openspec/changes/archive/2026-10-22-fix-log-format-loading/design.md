# Design

## Context

See `proposal.md` for motivation. The current demo entrypoints statically import
the logging module before calling `loadDotEnv()`, while the writer is selected at
module initialization from `process.env`.

## Goals / Non-Goals

**Goals:**

- Ensure `.env` and explicit process environment values are available before the
  demo imports or initializes the operational log writer.
- Make the local demo visibly readable while preserving explicit JSON output for
  machine-oriented deployments.
- Keep the existing allowlist, bounded sink and fail-open behavior unchanged.

**Non-Goals:**

- Replace the safe logging boundary with a third-party logger.
- Change log fields, trace propagation, business responses or production log
  retention policy.

## Decisions

- Use top-level environment loading followed by dynamic imports in both demo
  entrypoints. This fixes the initialization-order defect at its source; merely
  setting the variable later cannot reconfigure an already-created writer.
- Keep `IAR_LOG_FORMAT` as the explicit switch and set the local `.env` value to
  `pretty`. This makes the demo readable without removing the `json` option.
- Add a subprocess regression test that loads the environment before importing
  the writer and verifies the first emitted line is bilingual. A subprocess
  models the real module initialization boundary better than mutating the
  parent test process.

## Risks / Trade-offs

- [Risk] Dynamic imports can hide import failures until after environment setup.
  → The existing startup failure classification and bounded shutdown path remain
  the single error boundary.
- [Risk] Pretty output is less convenient for log ingestion.
  → `IAR_LOG_FORMAT=json` remains documented and available for deployments.

## Migration Plan

1. Set `IAR_LOG_FORMAT=pretty` in the local demo environment and restart the
   process.
2. Verify the startup, stage and completed-turn records use bilingual labels.
3. Roll back by setting `IAR_LOG_FORMAT=json` and restarting; no persisted data
   or protocol migration is required.
