# Tasks

## 1. Continuation target recovery

- [x] 1.1 Add a failing bridge regression proving a stable verified route plus a generic continuation is not classified as `pass_through` when semantic extraction omits intent/action.
- [x] 1.2 Implement collection-first and route-second exact descriptor recovery, with action ambiguity remaining a structured clarification.

## 2. Named parameter completion

- [x] 2.1 Add a failing regression for inheriting a validated named context slot while collecting a current-turn parameter.
- [x] 2.2 Implement schema-compatible named-slot merging and ensure current-turn values take precedence without positional remapping.

## 3. Safety and verification

- [x] 3.1 Add a failing regression for stale/disabled recovered targets and verify no Handler or Pi execution is authorized.
- [x] 3.2 Run OpenSpec strict validation, focused tests, build, lint and the full test suite; review route authority, confirmation, privacy and backend recovery behavior.

## Workflow follow-up

- Archive this OpenSpec change after implementation review and per-task audit pass.
- Merge the verified task branch into the confirmed `master` integration branch and verify the final integration branch contains the complete change.
