# Nested Plugin/Function Routing — Task 7 Audit

## Scope

Task 7 completes the integration gate for the nested Plugin/Function route and
confirms that the OpenAI-compatible Function Calling boundary remains separate
from the Runtime-owned Plugin/Function authorization boundary.

## Verification

- `npm run lint` passed.
- `npm test` passed for the complete repository test suite.
- `git diff --check` passed.
- `openspec validate nested-plugin-function-routing --strict` passed.
- Focused regression coverage passed for:
  - nested tool projection and OpenAI tool envelope;
  - normal `route.propose` model transport;
  - JEV/Intent compatibility selection;
  - provider timeout and malformed tool-call rejection;
  - confirmation and session follow-up behavior;
  - response contract (`model`, `direct`, and `none` modes);
  - safe timing/Trace ID logging and streamed responses;
  - Plugin scale and named-argument position stability.

## Contract review

- The provider sends only the standard OpenAI-compatible shape:

  ```json
  {
    "type": "function",
    "function": {
      "name": "plugin_<normalized-id>",
      "description": "...",
      "parameters": { "type": "object", "properties": {}, "required": [] }
    }
  }
  ```

- IAR-only ownership data is not sent as extra fields inside the OpenAI
  `function` object. The Runtime keeps the Plugin-to-Function candidate
  binding locally and rejects tool, Function, Operation, argument, ownership,
  authorization, policy, and confirmation mismatches before execution.
- Custom Plugin input and output Schemas are validated at installation/startup;
  invalid contracts fail closed and do not silently use a mock provider.
- Query/read and `mode=model` results use `response.generate`; confirmation,
  form, and `mode=none` paths do not fabricate a model reply.
- `semantic.extract` and `route.propose` use the normal model profile. JEV and
  Intent Model remain explicit compatibility backends for the legacy selection
  path only.

## Reliability and logging review

- External model calls have bounded request timeouts, bounded response bytes,
  stable timeout/network/HTTP/invalid-response classification, and no raw
  prompt, response, token, or API-key logging.
- HTTP and model records carry request/Trace IDs; the UI exposes total duration,
  per-stage timing, model role, and Trace ID.
- The safe logger keeps a bounded asynchronous queue and a bilingual terminal
  format while preserving machine-readable JSON as an explicit option.
- Runtime authorization is rechecked after model proposal and before execution;
  no model output grants permission or ownership.

## Review result

No CRITICAL or HIGH findings remain for the implemented scope. The change is
ready to archive after the final clean-worktree check and commit/push.
