# Tasks

## 1. Profile environment override contract

- [x] 1.1 Add optional non-secret environment variable names for endpoint, API key, and model ID to `ModelProfile`; validate keys and preserve compatibility for profiles without the mapping.
- [x] 1.2 Add tests for valid mappings, malformed variable names, empty values, default fallback, and secret values never entering profile/audit output.

## 2. OpenAI-compatible Providers

- [x] 2.1 Refactor the normal interaction provider to resolve endpoint, API key, and model ID from profile mapping/environment with explicit precedence and stable missing-config errors.
- [x] 2.2 Add an Intent Model provider using the same HTTP boundary but fixed Intent Prompt input and independent environment variables.
- [x] 2.3 Add deterministic HTTP tests covering endpoint, Authorization, model name, JSON-only request, timeout/error mapping, and no secret leakage.

## 3. Runtime/example configuration

- [ ] 3.1 Update root and sandbox model profiles with independent normal/Intent environment mappings and non-secret defaults; keep JEV priority and mock profiles compatible.
- [ ] 3.2 Wire both providers into the sandbox without changing public route/decision contracts; verify Intent-only and JEV-priority paths.
- [ ] 3.3 Update `.env.example`, README, sandbox README, and implementation audit with exact variable names and precedence.

## 4. Verification and release

- [ ] 4.1 Run focused provider/profile/routing tests plus `npm run lint`, `npm run build`, `npm test`, `git diff --check`, and strict OpenSpec validation.
- [ ] 4.2 Complete per-task audit, merge to `master`, archive the OpenSpec change, rerun final verification, and push `origin/master`.
