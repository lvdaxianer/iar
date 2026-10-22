# Nested Plugin/Function Routing — Task 6 Audit

## Scope

Task 6 aligns the user-facing model/configuration documentation with the nested OpenAI tool route and documents startup validation for custom Plugin contracts.

## Implemented behavior

- Added [`nested-plugin-function-calling.md`](../nested-plugin-function-calling.md), including the exact OpenAI-compatible `tools[].type=function` envelope, `tool_choice`, normalized name constraints, named arguments, runtime revalidation, and startup checks.
- Updated the root README, Function definition guide, and Agent Sandbox README to describe `semantic.extract → route.propose → Runtime validation → Function/Operation → response.generate`.
- Updated `.env.example` so `IAR_LLM_*` is documented as the primary model connection and `IAR_INTENT_MODEL_*` is documented only for the explicit legacy JEV/Intent compatibility path.
- Documented that invalid Plugin/Function/Operation ownership, input/output Schema, Handler, or OpenAI tool projection fails installation atomically and does not silently fall back to mock.

## Verification

- `npm run lint`
- `npm test -- --run tests/contract/function-response-contract.test.ts tests/integration/model-gateway/function-call-routing.test.ts tests/routing/nested-plugin-projection.test.ts`
- `git diff --check`
- `.env.example` contains no `sk-` credential value; all example credentials remain `CHANGE_ME`.
