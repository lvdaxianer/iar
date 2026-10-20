# Design

## Decision: Split relation extraction from candidate resolution

Semantic extraction remains model-facing and returns only `relation`, optional opaque `anchorRecordId`, `scope` and bounded `offset`. The runtime never parses domain words or interprets record values as identifiers.

`resolveFactRelationCandidates` first orders the verified fact chain, validates the anchor and computes the finite target set. Explicit `first`/`last` and anchored relations can resolve to one record. A relation without a usable anchor returns a bounded candidate set instead of guessing. The existing `resolveFactRelation` API remains a compatibility wrapper for callers that require a single deterministic result.

## Decision: Persist pending reference state as data-only session state

`BehaviorContext.pendingReference` stores the original reference text, normalized relation, optional anchor/offset and candidate record IDs. It is included in the BehaviorContext schema, critical-field hash, clarification event projection, compaction allow-list and snapshots. It contains no action, Function, Plugin or business-specific field.

When a reference is ambiguous, the session sets this state and passes candidate records to the response model. The route is not executed. A later turn can resolve the same finite candidate set; successful resolution clears the pending reference through the normal clarification state update.

## Decision: Keep all verified records append-only

Candidate resolution reads ordered records and returns cloned records. It never mutates or replaces `factHistory.records`. Each successful action continues to append a new verified record with its source event and sequence, so equal dynamic field names from different results remain distinguishable by opaque record ID and order.

## Decision: Use generic fallback and existing dynamic capability escalation

Ambiguous references use a stable reason code and generic candidate metadata. The response generator may ask the user to choose, while the scripted fallback only describes ordinal records and never names a business entity. Existing unresolved-streak escalation continues to build options from runtime Plugin descriptors; no feature list is embedded in the resolver.

## Safety and bounds

- Candidate records are capped by the existing clarification option bound.
- Record IDs are validated against the existing fact-record schema and remain opaque.
- Invalid anchors, offsets, malformed pending state and stale candidate IDs fail closed.
- Pending reference state is not an authorization source; a fresh semantic frame, route, policy and confirmation remain required for any side effect.
- Recent messages remain bounded untrusted model input and are not copied into trusted facts.
