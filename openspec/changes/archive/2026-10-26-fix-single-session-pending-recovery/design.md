# Design

## Context

The existing runtime correctly protects an unconfirmed action from ordinary
topic changes, but the same guard also prevents a user from withdrawing with
plain language such as “算了，不建了”. A long real-model session additionally
showed that after compaction a question about a completed adjustment can be
returned to the action route when the model omits the historical relation.

## Approach

1. Add a narrow, language-level cancellation classification at the pending
   workflow boundary. It may clear pending confirmation or parameter collection
   only when the current turn is an explicit withdrawal; it must not accept an
   arbitrary “好/确认” as cancellation or confirmation.
2. Keep cancellation as a runtime event with no handler call and no successful
   fact projection.
3. Make the post-compaction continuation fallback prefer a validated historical
   read/status interpretation when the current text is a reference to a known
   result and does not contain a fresh action parameter. Any new action still
   goes through schema, policy and confirmation.
4. Bound the compaction model input to the shared event limit while retaining
   the source events referenced by the current verified fact history. This
   keeps the request within the contract without making valid fact references
   unverifiable after a long session.
5. Lock both behaviors with deterministic integration tests before changing
   production code, then rerun the 8878 real-model single-session driver.

## Boundaries and risks

- The change is limited to session routing, clarification, compaction and tests.
- No plugin operation, fixture value, side-effect implementation, or HTTP
  response contract is changed.
- Natural-language cancellation must be conservative; ambiguous text remains
  pending and asks the user to use explicit confirmation or cancellation.
- Real model output can still be variable, so route/state evidence is required
  in addition to reply text.

## Verification

- Focused RED/GREEN tests for pending withdrawal and post-compaction status
  follow-up, including proof that no handler executes before confirmation.
- Long-session compaction tests verify bounded event input, unchanged complete
  conversation history, preserved critical hash, and inclusion of fact source
  events.
- `npm run build`, `npm run lint`, `npm test`, `git diff --check`, and strict
  OpenSpec validation.
- One continuous real-model Pi session via `http://127.0.0.1:8878`, with the
  50 attached scenarios and explicit route/pending/action evidence.
