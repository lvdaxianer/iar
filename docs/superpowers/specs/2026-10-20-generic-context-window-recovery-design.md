# Generic Context Window and Recovery Design

## Decision

IAR will provide models with two complementary, bounded inputs: the validated structured `BehaviorContext` and a configurable recent-message window reconstructed from the persisted message source. The structured snapshot remains the only source of trusted facts and execution state; raw messages are untrusted interpretation data and never authorize actions.

## Data boundaries

```text
BehaviorContext snapshot  -> trusted facts, routing scope, pending state
Session message source    -> complete ordered raw messages
Runtime context window    -> latest N bounded messages for model understanding
PluginHost descriptors    -> current finite Function/Plugin candidates
```

The runtime will not contain business names, keywords, hardcoded feature lists, or business-specific fallback branches. Candidate descriptions and selectable options are projected from enabled and authorized Plugin manifests.

## Model flow

Semantic extraction receives the current message, latest N raw messages, the structured context, and dynamic candidate descriptors. Function/Plugin selection continues to receive finite validated candidates and existing structured safety data. Response generation receives the same bounded conversational context for clarification and fact-based answers. Compaction continues to receive structured state and events only.

Every model result remains advisory. Registry state, authorization, capability checks, policy, confirmation, idempotency, and final execution validation remain in the Runtime.

## Persistence and recovery

SQLite already stores session messages and versioned structured snapshots. The persistence SPI will add a bounded latest-message query. On restore, the session loads the latest valid structured snapshot, then loads at most N ordered messages into the in-memory window. Failure to load messages preserves the trusted snapshot and uses an empty window. Raw messages are not duplicated into the structured snapshot.

The structured snapshot gains bounded clarification state: unresolved streak, mode, and current candidate keys/version. The state is data-only and does not authorize a Function or Plugin.

## Clarification escalation

The session counts consecutive semantic, routing, or input-clarification outcomes. The default threshold is two and remains configurable. Confirmation waits and successful progress reset the streak. At the threshold, the Runtime creates a finite selection from the current authorized descriptors. A selection is revalidated against the current registry and then re-enters the ordinary route, policy, confirmation, and execution pipeline.

## Acceptance criteria

- Colloquial follow-ups can use the latest bounded raw messages without treating them as facts.
- Restart restores both structured state and the latest configured message window.
- Selection options come only from current Plugin descriptors.
- Repeated unresolved turns escalate once to dynamic selection rather than looping indefinitely.
- Stale, unauthorized, disabled, or malformed selections never execute.
- Streaming and non-streaming paths receive equivalent context.
- Core Runtime and shared prompt code contain no business-specific feature list or keyword route.
