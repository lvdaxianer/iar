# Design

## Context

See `proposal.md` for the motivation. The current session already persists structured snapshots and individual session messages, and keeps a bounded in-memory `recentMessages` array. Restore currently loads only the structured snapshot, while semantic and response model inputs do not receive the recent-message window. The routing layer already has finite, authorized Plugin candidates and revalidates selected candidates before execution.

The existing structured-context contract also separates model interpretation from execution authority. This change preserves that boundary while allowing a bounded raw-message window to improve conversational understanding.

## Goals / Non-Goals

**Goals:**

- Pass a configurable, bounded recent-message window to semantic extraction, fallback responses and response generation.
- Rebuild that window after restart from the existing persisted message source.
- Generate clarification choices from the current authorized Plugin descriptors rather than static business lists.
- Persist and restore unresolved clarification state and pending dynamic choices.
- Escalate repeated unresolved turns to a finite selection state, then re-enter the normal routing and policy pipeline after a valid selection.
- Keep streaming and non-streaming paths equivalent.
- Keep the core Runtime free of business names, keywords, domain rules and hardcoded feature lists.

**Non-Goals:**

- Do not make recent raw messages trusted facts or an authorization source.
- Do not send raw message history to the compaction model.
- Do not bypass Function/Plugin candidate filtering, authorization, policy, confirmation or idempotency.
- Do not introduce a new database table for a duplicate recent-message snapshot.
- Do not change Plugin execution semantics or invent a business-specific intent classifier.

## Decisions

### 1. Keep three separate data planes

Use three explicitly separated representations:

1. **Structured snapshot**: the validated `BehaviorContext`, including trusted facts, routing scope, pending clarification and unresolved state.
2. **Message source**: the existing persisted `SessionMessage` records in the configured Provider, including SQLite's message table.
3. **Model input window**: a runtime-derived list containing the latest configured N messages, each bounded by count and text length.

The model input window is reconstructed from the message source after restore and is never copied into trusted facts. Storing the same raw messages in both the snapshot and message table would create duplicate retention, revision and recovery semantics.

### 2. Extend the persistence SPI with a bounded latest-message read

Add an optional bounded query shape to the Provider contract, such as `listMessages(sessionId, { limit })`, with a stable chronological result order. The SQLite implementation will query the existing message table in descending sequence with a limit and reverse the result before returning it. Providers that cannot supply the window may return a stable capability error; the runtime preserves a valid structured snapshot and uses an empty window.

This is preferred over loading the full message table because message history can grow independently of the model window. It also lets external Providers implement an efficient native query without changing model-routing code.

### 3. Pass recent messages only to interpretation-oriented roles

The semantic extractor, fallback response and response generator receive `currentMessage`, `recentMessages`, `BehaviorContext` and a dynamic candidate descriptor catalog. Function/Plugin selection receives the current semantic facts and finite candidates; it may retain the current message and structured context but does not need the full raw window. The compaction role continues to receive structured state and events only.

All model prompts label recent messages and structured context as untrusted data. A valid model result remains advisory until shared schema validation, candidate filtering, registry authorization, policy and confirmation gates complete.

### 4. Build candidate descriptions from PluginHost state

Introduce a generic descriptor projection over enabled, authorized business Plugins. The projection contains only data declared by the Plugin contract: opaque candidate identifiers, Function/Plugin identifiers, descriptions, fixed action types, and any declared operation metadata. The runtime uses this projection to construct semantic input and selection options. It does not inspect business words or maintain a static feature list.

Pending selection keys are opaque candidate identifiers from the current descriptor snapshot. On the next turn the runtime validates the key against the current enabled and authorized candidates before narrowing the route. Selection never directly creates an Action.

### 5. Track unresolved clarification as durable generic state

Maintain a bounded clarification state containing a consecutive unresolved streak, the last stable reason code, the current mode, and the pending candidate version/keys when selection is active. The streak increments only for semantic, routing or input-clarification outcomes; confirmation waits and successful progress reset it. A configurable threshold (default two) transitions the session to dynamic candidate selection. A missing or stale candidate set fails closed with a safe clarification.

The state belongs in the validated structured snapshot so the same behavior survives restart. Raw message content remains in the message source and is not embedded in the state.

### 6. Preserve one routing pipeline after selection

When a user selects a pending candidate, the runtime resolves the opaque key against the current descriptor set and feeds the narrowed finite scope into the existing SemanticFrame → route → authorization → policy → confirmation → execution pipeline. No selection path may call a Plugin directly or skip revalidation. This keeps selection, ordinary natural-language routing and recovered sessions on the same safety path.

### 7. Migrate prompt contracts from static catalogs to injected descriptors

The semantic and response prompt builders will describe the protocol generically and receive the current candidate descriptors as data. Example applications may still register sample Plugins and their descriptions, but core Runtime and shared prompt contracts will not enumerate those examples or contain business keyword rules.

## Risks / Trade-offs

- [Risk] Raw messages increase prompt size and may contain sensitive or prompt-injection content → enforce count/character bounds, label them as untrusted data, avoid sending them to compaction, and preserve existing safe logging that excludes prompt bodies.
- [Risk] A Provider implementation may not support efficient recent-message reads → make the SPI capability explicit, fail safe to an empty window, and keep structured snapshot recovery independent.
- [Risk] A stale pending candidate may be selected after Plugin lifecycle or authorization changes → re-collect and revalidate candidates at selection time; reject stale keys without execution.
- [Risk] Repeated clarification may be triggered by a transient provider failure → count stable unresolved outcomes at the session boundary, reset after successful progress, and keep the threshold configurable.
- [Risk] Dynamic descriptors may be incomplete → treat missing descriptions or malformed operation metadata as invalid candidate data and exclude the candidate rather than inventing labels or operations.
- [Risk] Snapshot schema changes can affect existing SQLite files → add optional, backward-compatible fields with validation defaults; preserve old snapshots and use an empty clarification state when fields are absent.

## Migration Plan

1. Extend contracts and the Provider SPI with optional bounded recent-message reads and validated generic clarification state.
2. Update SQLite and the in-memory/test Providers; retain the existing message table and add bounded, ordered reads.
3. Restore the structured snapshot first, then load the latest configured message window. If the message read fails, keep the snapshot and use an empty window.
4. Replace static shared prompt catalogs with injected Plugin descriptors and pass the same context through streaming and non-streaming paths.
5. Add the unresolved-state transition and dynamic selection handling without changing existing execution gates.
6. Verify old snapshots, file-backed resume, provider flush/close, duplicate selections, stale candidates, and the existing full test suite.
7. Rollback can disable the recent-message input feature and dynamic escalation while retaining the existing snapshot/message tables; no destructive data migration is required.
