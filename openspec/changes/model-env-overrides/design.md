# Design

## Configuration model

Model profiles keep non-secret defaults (`provider`, `modelId`, `modelVersion`) and add an optional environment override mapping. The mapping contains only environment variable names, never resolved secrets:

```json
{
  "environment": {
    "endpoint": "IAR_INTENT_MODEL_ENDPOINT",
    "apiKey": "IAR_INTENT_MODEL_API_KEY",
    "modelId": "IAR_INTENT_MODEL_ID"
  }
}
```

At provider invocation time, each field resolves with this precedence:

1. a non-empty environment variable named by the profile mapping;
2. the profile's non-secret default (`modelId` or provider default endpoint);
3. fail closed for endpoint/key when the provider requires them.

Environment variable names are validated as identifiers. Resolved values never enter `ModelProfile`, audit metadata, error details, or logs.

## Providers

- `OpenAICompatibleModelProvider` handles `chat/completions`, JSON response format, timeout signal propagation, stable provider error classification, and configurable environment mapping.
- `BrainModelProvider` remains the normal interaction provider and defaults to `IAR_LLM_BASE_URL`, `IAR_LLM_API_KEY`/`IAR_MODEL_API_KEY`, and `IAR_LLM_MODEL_ID`.
- `IntentModelProvider` is configured independently with `IAR_INTENT_MODEL_ENDPOINT`, `IAR_INTENT_MODEL_API_KEY`, and `IAR_INTENT_MODEL_ID`. It sends the adapter-provided fixed Intent Prompt and request JSON, never the raw user input as an unbounded error.
- JEV remains a separate provider/backend. If JEV and Intent Model profiles coexist, `DecisionBackendResolver` still selects JEV.

## Runtime and safety

Providers receive the existing frozen `ModelProviderRequest`; only the HTTP request body is provider-specific. API keys are used only in the Authorization header. Non-2xx responses, network failures, empty content, malformed JSON, and missing required configuration become stable provider failures and follow existing retry/fallback rules.

The core gateway remains provider-injection based. The sandbox wires both providers explicitly and its profiles declare environment mappings, making the deployment contract executable without making the core gateway read global environment state.

## Compatibility

Profiles without `environment` remain valid. Existing mock providers and tests continue to work. Existing model IDs remain defaults when no override variable is set. Public decision and route contracts are unchanged.
