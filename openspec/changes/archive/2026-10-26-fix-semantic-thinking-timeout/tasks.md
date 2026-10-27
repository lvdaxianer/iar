# Tasks

## Contract and tests

- [x] Add a failing provider test proving `semantic.extract` sends explicit disabled thinking.
- [x] Add a failing provider test proving ordinary function/Intent Model decisions send explicit disabled thinking.
- [x] Add a failing Bridge client test proving `IAR_PI_BRIDGE_TIMEOUT_MS` controls the default deadline and invalid values fail fast.

## Implementation

- [x] Apply the disabled-thinking policy to semantic extraction and decision prompt builders.
- [x] Read the bounded Bridge timeout environment variable when no explicit client timeout is supplied.
- [x] Preserve `response.generate` reasoning behavior and existing stable error classifications.

## Verification and integration

- [x] Run the focused tests and confirm they pass after the implementation.
- [x] Run build, lint, and relevant integration tests.
- [x] Review the diff for logging/privacy, timeout, and response-generation regressions.
- [x] Mark the OpenSpec tasks complete, commit the change, and merge it into `master`.
