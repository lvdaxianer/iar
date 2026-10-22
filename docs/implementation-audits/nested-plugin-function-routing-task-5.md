# Nested Plugin/Function Routing — Task 5 Audit

## Scope

Task 5 adds observability for the nested route and a repeatable local benchmark for Plugin scale and named arguments.

## Implemented behavior

- `route.propose` is a first-class timing stage for normal and streamed turns.
- Model HTTP records carry a safe `modelRole`, including `route.propose`, so route extraction and response generation can be distinguished without logging prompt, response, thinking text, token content, or API keys.
- The existing bilingual safe logger renders Chinese and English labels, stage, role, outcome, duration, first-token timing, and Trace ID.
- Pi bridge timing validation accepts the new `route.propose` stage.
- `nested-routing-benchmark.test.ts` records 1/5/10/20/40 Plugin request size, TTFB, total time, and success rate using a local OpenAI-compatible fetch stub.
- The benchmark intentionally records that 40 requested Plugins are projected as 32 tools because the existing `MAX_ROUTING_SCOPE_PLUGINS` safety limit applies.
- Twenty named-argument cases alternate JSON property order and verify the same field identity after proposal validation, Function input construction, and JSON Schema validation.

## Evidence

```text
nested-route-benchmark [{"plugins":1,"tools":1,"payloadBytes":1304,"ttfbMs":1.297,"totalMs":10.636,"successRate":1},{"plugins":5,"tools":5,"payloadBytes":6516,"ttfbMs":0.417,"totalMs":0.952,"successRate":1},{"plugins":10,"tools":10,"payloadBytes":13031,"ttfbMs":0.477,"totalMs":0.864,"successRate":1},{"plugins":20,"tools":20,"payloadBytes":26091,"ttfbMs":0.626,"totalMs":1.073,"successRate":1},{"plugins":40,"tools":32,"payloadBytes":41763,"ttfbMs":0.796,"totalMs":1.607,"successRate":1}]
```

The timing values above are local protocol measurements, not external model latency. Real provider latency remains visible through `model.http` records keyed by the same Trace ID.

## Verification

- `npm run lint`
- `npm test -- --run tests/integration/agent-sandbox/response-observability.test.ts tests/integration/agent-sandbox/safe-observability.test.ts tests/integration/agent-sandbox/safe-observability-stream.test.ts`
- `npm test -- --run tests/routing/nested-routing-benchmark.test.ts`
- `git diff --check`
