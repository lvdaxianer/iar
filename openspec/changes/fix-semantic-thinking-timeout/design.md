# Design: Bound intent extraction latency without changing response generation

## Root cause

`semantic.extract` is sent through the OpenAI-compatible chat transport without an
explicit `thinking` option. The upstream model may therefore spend time producing
reasoning even though the result is a bounded structured frame. The same omission
exists on the ordinary function-decision prompt and the Intent Model prompt.

The Bridge client separately has a 10-second default timeout, but the Pi host does
not pass a configured value. A slow downstream request is consequently reported to
the user only as a generic bridge timeout, with no safe deployment-level control.

## Design

1. Treat reasoning as a per-request policy, not a provider-wide switch.
   - `semantic.extract`, `function.call`, `function.select`, `plugin.select`, and
     `route.propose` send `{ type: "disabled" }` explicitly.
   - `response.generate` remains unchanged so the final DeepSeek response can keep
     its configured native reasoning behavior.
   - Existing nested function routing already sends this option; the change makes
     the ordinary function and semantic/Intent Model paths consistent.

2. Make Bridge timeout configuration explicit and bounded.
   - `IAR_PI_BRIDGE_TIMEOUT_MS` is used only when the constructor caller does not
     provide `timeoutMs`.
   - The existing 10,000 ms default remains the fallback when the environment key
     is absent.
   - The existing 60,000 ms maximum and stable `invalid_bridge_timeout` error remain
     the safety boundary; malformed, non-integer, non-positive, or oversized values
     fail at construction instead of silently changing behavior.

3. Keep error semantics distinct.
   - A client-side deadline remains `bridge_timeout`.
   - A server response that reports a model failure remains `response_model_failed`.
   - No raw prompt, token, or model response is added to logs.

## Verification strategy

- Capture outgoing OpenAI-compatible request bodies in provider integration tests.
- Assert extraction and decision bodies disable thinking, while response generation
  does not gain an implicit disabled option.
- Set the Bridge timeout environment variable in client tests and assert the abort
  is observed; also assert invalid configuration is rejected.
- Run focused tests, build, lint, and the relevant broader integration tests.
- Because the currently running demo loads the repository's existing `dist`, restart
  is required before observing the behavior in the browser.
