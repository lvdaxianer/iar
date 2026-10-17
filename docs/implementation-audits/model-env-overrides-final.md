# Model Environment Overrides — Final Audit

## Decision

PASS — normal interaction model and Intent Model endpoint, API key, and model ID can be independently overridden through environment-variable mappings while the public model and routing contracts remain stable.

## Delivered behavior

- `ModelProfile.environment` accepts only non-secret variable names for `endpoint`, `apiKey`, and `modelId`.
- Normal interaction profiles use `IAR_LLM_BASE_URL`, `IAR_LLM_API_KEY`, and `IAR_LLM_MODEL_ID`, with `IAR_MODEL_API_KEY` retained as a compatibility fallback.
- Intent Model profiles use independent `IAR_INTENT_MODEL_ENDPOINT`, `IAR_INTENT_MODEL_API_KEY`, and `IAR_INTENT_MODEL_ID` variables.
- Profile mappings take precedence when their values are non-empty; model IDs fall back to the profile default, while endpoint/API key absence fails closed.
- Both providers use the same OpenAI-compatible JSON boundary. Intent Model requests include the fixed `iar.intent-decision-prompt/v1` boundary and return the same `iar.decision/v1` shape.
- JEV remains the resolver’s default priority. The sandbox can explicitly select `intent-model` while keeping the same route output and authorization gates.
- Secrets and upstream failure details do not enter profiles, audits, public errors, or provider error messages.

## Verification evidence

- Focused provider/profile/routing/sandbox tests: `28/28 PASS`.
- Full test suite: `304/304 PASS`.
- `npm run lint`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- `openspec validate model-env-overrides --strict`: PASS.

## Changed surface

- Decision profile contract and validation.
- OpenAI-compatible normal and Intent Model providers.
- Root and sandbox model profiles.
- Sandbox async unified decision wiring and backend selector.
- Root README, sandbox README, `.env.example`, and per-task audits.
