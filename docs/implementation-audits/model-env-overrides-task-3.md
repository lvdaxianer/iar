# Model Environment Overrides — Task 3 Audit

## Status

PASS — runtime profiles, sandbox providers, and documentation are aligned.

## Scope

- Root and sandbox profiles declare normal-model and Intent Model environment mappings without storing secret values.
- Sandbox wires `BrainModelProvider`, `IntentModelProvider`, and deterministic decision provider through `ModelGateway`.
- Default sandbox behavior loads both decision backends and keeps resolver-level JEV priority.
- `IAR_SANDBOX_DECISION_BACKEND=intent-model` (or the equivalent constructor option) selects an Intent-only profile set for controlled operation.
- Both paths use `routeAsync` and preserve the existing public route/DecisionResult shape and final runtime gates.
- Root README, sandbox README, and `.env.example` document exact variables and precedence.

## Evidence

- Profile, routing, and sandbox integration tests: `28/28 PASS`.
- `npm run lint`: PASS.
- `git diff --check`: PASS.
- `openspec validate model-env-overrides --strict`: PASS.

## Security and compatibility review

- Configuration files contain only environment variable names and safe model defaults.
- JEV, Intent Model, and ordinary interaction variables are independently named.
- Existing scripted mode remains offline and deterministic; real mode fails closed when required endpoint/key values are absent.
- Route output remains `RouteResult`; model backend selection does not grant capabilities or bypass authorization/policy gates.
