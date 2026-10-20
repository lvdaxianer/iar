# Tasks

## 1. Bridge package contract

- [x] 1.1 Create `@iar/pi-bridge` package metadata, TypeScript project reference, versioned protocol types and public exports; verify `npm run lint` resolves the package boundary.
- [x] 1.2 Add package smoke coverage for the public entrypoint, declaration metadata, four dispositions and `pi.extensions`; verify `npm run verify:packages` covers the new package.

## 2. Pi client and extension

- [x] 2.1 Implement the bounded IAR HTTP client with timeout, response validation, stable errors and safe debug/warn logging; verify mocked fetch tests cover open, input, confirm, state, HTTP failure and malformed response.
- [x] 2.2 Implement the Pi lifecycle/input extension, custom result presentation, explicit confirm/cancel commands, extension-source recursion guard and fail-closed default; verify extension tests cover all dispositions and bridge failure.
- [x] 2.3 Export a Pi Package entrypoint without a runtime Pi dependency and document CLI/SDK loading; verify the package can be imported through its public entrypoint.

## 3. IAR bridge server

- [x] 3.1 Add `pass_through` to the session result and implement `bridgeTurn` by reusing the existing session pipeline; verify ordinary `/api/chat` behavior is unchanged and unknown bridge input does not generate an IAR reply or execute a Plugin.
- [x] 3.2 Add versioned bridge session, input, confirmation, cancellation and state routes with bounded validation and Pi→IAR mapping; verify integration tests cover mapping reuse, session isolation, known business input, clarification and pending confirmation.
- [x] 3.3 Route bridge operations through the existing reservation queue and extend safe audit allowlists; verify malformed input, stale action IDs, duplicate confirmation and request serialization tests pass without logging raw request data.

## 4. Integration verification

- [ ] 4.1 Update README with installation, SDK loading, session ownership, dispositions, fail-closed behavior and confirm/cancel commands; verify every documented path matches the exported API and HTTP routes.
- [ ] 4.2 Run `openspec validate integrate-iar-with-pi --strict`, `npm run lint`, `npm run build`, `npm run verify:packages` and `npm test`; verify all commands exit 0.
- [ ] 4.3 Review `git diff --check`, changed-file security/reliability rules, and Pi repository status; verify no file under `/Users/lvdaxianer/workspace/my/project/pi` changed and no unresolved task remains.

## Workflow follow-up

- After implementation review and user acceptance, archive the OpenSpec change and integrate the task branch into `master` according to the repository workflow.
