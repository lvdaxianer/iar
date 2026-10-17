# Model Environment Overrides — Task 2 Audit

## Status

PASS — normal and Intent Model providers share the OpenAI-compatible HTTP boundary.

## Scope

- Normal interaction provider resolves endpoint, API key, and model ID from profile-declared environment mappings.
- Intent Model provider has independent default variables: `IAR_INTENT_MODEL_ENDPOINT`, `IAR_INTENT_MODEL_API_KEY`, and `IAR_INTENT_MODEL_ID`.
- Profile mappings take precedence over provider defaults; empty environment values do not override valid fallbacks.
- Model ID falls back to the profile value, preserving existing profiles.
- Intent requests use `iar.intent-decision-prompt/v1`, `iar.decision/v1`, and JSON-only response format.
- Transport, HTTP, malformed JSON, and missing configuration errors map to stable `ModelProviderError` kinds.

## Evidence

- Deterministic provider tests: `4/4 PASS`.
- `npm run lint`: PASS.
- `git diff --check`: PASS.
- Requests assert endpoint, bearer authorization, model ID, JSON response format, and Intent prompt version.

## Security and compatibility review

- API key values are read only at provider invocation and never copied into profiles or errors.
- Upstream response bodies and transport exception messages are not propagated.
- Existing `IAR_MODEL_API_KEY` remains a compatibility fallback for the normal provider.
