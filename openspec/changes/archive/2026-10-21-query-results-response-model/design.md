# Design

## Context

See `proposal.md` for the motivation. The current runtime already has a versioned `FunctionResponse` envelope, a bounded `factHistory`, a Response Generator, and separate Pi Bridge route evidence. Operation selection is represented by the Function's operation catalog and the constructed Action input; the existing `sandboxOperationKind` helper can distinguish read operations from side-effecting actions. Handler output Schema validation currently occurs in the plugin worker, while response-mode validation is generic and does not know the selected operation kind.

## Goals / Non-Goals

**Goals:**

- Make read/query results consistently enter Response Model generation.
- Keep Function output as bounded structured facts and keep final wording in the response layer.
- Preserve `direct` and `none` for explicitly allowed non-query paths.
- Carry the three response prompt layers and structured Function output through one input shape.
- Distinguish a uniquely answered verified-context follow-up from a clarification in internal and Bridge-visible status.
- Expose selected Function/Plugin identifiers and reply source without exposing raw prompts or model payloads.
- Add focused contract, integration, streaming and Pi Host regression coverage.

**Non-Goals:**

- Do not let the response model select or execute a Function.
- Do not change Plugin authorization, confirmation, idempotency or fact provenance rules.
- Do not make the generic contracts package interpret business operation names.
- Do not replace the existing three response modes or introduce a second user-facing model protocol.
- Do not make historical fact follow-ups re-run a read Function unless the user explicitly requests a fresh query.

## Decisions

### 1. Resolve policy from the selected operation kind

The runtime will compute a bounded operation kind (`read` or `action`) from the selected operation catalog entry and constructed input before interpreting the Handler result. A read result with `mode=direct` or `mode=none` will fail closed unless the Function registration explicitly marks a non-chat exception. A successful read result with `mode=model` will always use the existing Response Generator path.

**Alternative considered:** infer the policy from `FunctionDefinition.actionTypes` or the Function ID. Rejected because one Function can expose both read and side-effecting operations, as `ticket.create` already does.

### 2. Keep generic response Schema validation separate from operation policy

The contracts package will continue validating the versioned shape and bounds of `FunctionResponse`. The sandbox execution boundary will apply the operation-aware compatibility policy after Handler output validation and before the ActionResult is accepted. This keeps the public contract reusable while ensuring the runtime does not silently accept a query result that bypasses the model.

**Alternative considered:** add `operationKind` to `FunctionResponse`. Rejected because the operation is selected by the runtime and should not be trusted from an untrusted Handler response.

### 3. Use one Response Model input projection

The response layer will continue to build one bounded input object containing the current user message, selected Function/Plugin, operation kind, action status, validated Function output, response envelope, BehaviorContext, recent messages, Agent overall prompt and Function supplementary prompt when applicable. The base response instructions remain owned by the runtime. Model output remains validated as `iar.response/v1`.

Self-introduction continues to pass its capability inventory and supplementary prompt as structured Function output; it does not receive a special direct rendering path.

### 4. Separate verified-context answers from generic clarification

When no Function is selected, the runtime will retain the existing fail-closed fact resolution. If a historical reference resolves uniquely and the Response Model returns an answer, the public result will use a context-answer disposition; if evidence is missing or ambiguous, it will use clarification. Neither path carries Function/Plugin selection or executes an action.

**Alternative considered:** keep every no-route model result as `clarification`. Rejected because the UI and Bridge cannot distinguish “answered from trusted facts” from “needs user input,” which caused the observed misleading route panel.

### 5. Preserve reply-source semantics across Bridge and Pi Host

The Bridge response will keep `response_model` for both Function-backed model summaries and verified-context answers, while route evidence will include Function/Plugin IDs only when a business route was selected. The Pi Host will render the status and source from the validated Bridge response rather than infer them from message text.

## Data Flow

```text
semantic extraction
  -> route / selected operation
  -> build Action input
  -> execute Handler in worker
  -> validate Function result and output Schema
  -> validate operation-aware response policy
  -> ActionResult
  -> response mode:
       model -> Response Generator -> validated text
       direct -> bounded Function text
       none -> host state only
```

For a historical follow-up:

```text
semantic extraction (unknown/query + historical reference)
  -> resolve verified fact
  -> no Function route
  -> fallback Response Generator with fact context
  -> context_answered or clarification
```

## Risks / Trade-offs

- **[Existing custom Function returns direct for a read operation]** → fail closed with a stable contract error; provide a migration test and keep explicit non-query exceptions documented.
- **[Scripted mode hides a missing real model call]** → instrument the same response-source and input-shape assertions in scripted tests; brain-mode integration tests use a recording provider.
- **[Old 8787 bridge and new 8788 host run different builds]** → include route evidence assertions at the HTTP Bridge boundary and require the demo startup path to build both sides before launch.
- **[Model paraphrases a verified fact incorrectly]** → preserve bounded fact values and prompt the model to quote identifiers/statuses only from structured context; validate response envelope but never promote generated prose back into trusted facts.
- **[Changing clarification status breaks older clients]** → keep the existing `clarification` response shape compatible and add a stable optional disposition/source field; update the Pi Host renderer and bridge validators together.

## Migration Plan

1. Add failing contract and integration tests for read/query model routing, operation-aware mode rejection, self-introduction, historical fact answers and Pi Host evidence.
2. Implement the operation-aware policy at the validated Handler-result boundary and route all `model` results through the shared response layer.
3. Add the context-answer disposition and propagate it through session results, Bridge responses and Pi Host rendering.
4. Run focused tests, package/build validation, OpenSpec strict validation and the broader repository test suite.
5. If a compatibility issue appears, temporarily preserve the old external disposition while retaining the internal fact-answer classification; no data migration is required.

