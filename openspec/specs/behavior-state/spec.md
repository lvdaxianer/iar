# Behavior State

## Purpose

为 IAR 保留不可变事实和当前行为状态，使会话继续、进程重启、重试及上下文压缩后仍能恢复同一主语、动作、路由和工作流位置。

## Requirements

### Requirement: EventLog is the recovery source of truth

The runtime SHALL append immutable events containing correlation identifiers, schema versions, route decisions, policy outcomes, action results, and workflow transitions; snapshots and projections SHALL be rebuildable from that event sequence.

#### Scenario: State is rebuilt after restart

- **WHEN** the process restarts after a workflow transition has been appended
- **THEN** replaying the events reconstructs the same BehaviorContext and workflow step without relying on in-memory conversation history

### Requirement: BehaviorContext preserves critical execution state

The current behavior state SHALL preserve subject identity and reference provenance, intent, action, Function, selected Plugin, slots, workflow step, pending input including bounded clarification metadata, confirmation state, idempotency key, integrity metadata, and the canonical `sessionId` association. It SHALL additionally preserve a bounded routing scope containing the active Plugin, finite candidate Plugin IDs, continuation state, and pending route information.

#### Scenario: Restored scope continues a follow-up

- **WHEN** a session snapshot is restored before a follow-up message
- **THEN** the next decision receives the same active Plugin scope and verified facts without replaying raw historical messages

#### Scenario: Reference resolution survives later input

- **WHEN** a previous event resolves “第一个服务” to stable subject `test1`
- **THEN** a later input can recover `subject.id=test1` and the source event without reinterpreting the original list

#### Scenario: Pending clarification survives later input

- **WHEN** response generation asks the user to choose from a finite option set
- **THEN** the pending kind, status and validated options are present in the BehaviorContext for the next turn

#### Scenario: Invalid pending metadata is rejected

- **WHEN** an event or restored snapshot contains invalid, oversized or duplicate clarification options
- **THEN** projection or restoration rejects that state and keeps the last valid BehaviorContext

#### Scenario: Pending state does not authorize execution

- **WHEN** a pending clarification option names a possible interpretation but no new validated route and policy decision exists
- **THEN** the runtime does not execute a Function or Plugin solely from the pending option

### Requirement: Context compaction cannot change executable state

Compaction SHALL validate schema, required paths, event references, current workflow state, confirmation scope, idempotency key, and critical-field hash before replacing a context view; on failure it SHALL retain the previous valid view and append a failure event.

#### Scenario: Compactor changes a confirmed route

- **WHEN** a compactor result changes `pluginId`, workflow step, or confirmation scope
- **THEN** the result is rejected, the previous valid context remains active, and `context.compaction_failed` records the validation failure

### Requirement: Replay and idempotency are deterministic

Replaying the same ordered event sequence SHALL produce the same projected behavior state, and submitting an action with an already-consumed idempotency key SHALL not create a second external side effect.

#### Scenario: Duplicate action submission

- **WHEN** the same action and idempotency key are submitted twice
- **THEN** the second submission returns the recorded outcome or an in-progress status and does not invoke the side effect again

### Requirement: Behavior state preserves fact order and focus

The projected behavior state SHALL retain a bounded ordered collection of verified fact records and an optional current focus record ID, and SHALL treat Function IDs, Plugin IDs and declared field keys as opaque dynamic values.

#### Scenario: Replay preserves record order

- **WHEN** the same immutable event sequence is replayed after restart
- **THEN** the projected fact records have the same IDs, source events, sequence order and focus record as before restart

#### Scenario: New fact does not overwrite prior fact

- **WHEN** a later event exposes a value with the same dynamic source and key as an earlier event
- **THEN** projection appends a new record and preserves the earlier record unchanged

#### Scenario: Invalid record metadata is rejected

- **WHEN** a fact record has an unknown source event, duplicate record ID, invalid sequence, or exceeds configured bounds
- **THEN** projection rejects that update and retains the last valid behavior state

### Requirement: Context compaction preserves trusted fact provenance

Context compaction SHALL retain the bounded verified fact history, source event references, sequence order and focus record, and SHALL NOT turn recent raw messages or generated summaries into trusted facts.

#### Scenario: Compaction retains historical references

- **WHEN** compaction succeeds after multiple verified results exist
- **THEN** a later `previous` relation can resolve against the same ordered fact history

#### Scenario: Invalid compaction cannot replace the chain

- **WHEN** a compaction result removes, reorders, or changes a verified record or its provenance
- **THEN** the result is rejected and the previous valid behavior state remains active

### Requirement: BehaviorContext preserves pending generic references

The projected behavior state SHALL preserve a bounded pending reference containing only the original relation, optional opaque anchor metadata and candidate record IDs, and SHALL replay it deterministically with the clarification event and snapshot.

#### Scenario: Pending reference is restored

- **WHEN** a session is restarted after an ambiguous historical reference
- **THEN** the pending reference and its candidate record IDs are available before the next decision

#### Scenario: Pending reference cannot alter authority

- **WHEN** a pending reference is present without a new route and policy result
- **THEN** it remains data-only and cannot authorize execution
