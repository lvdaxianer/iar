# Spec Delta

## Purpose

为 IAR 保留不可变事实和当前行为状态，使会话继续、进程重启、重试及上下文压缩后仍能恢复同一主语、动作、路由和工作流位置。

## ADDED Requirements

### Requirement: EventLog is the recovery source of truth
The runtime SHALL append immutable events containing correlation identifiers, schema versions, route decisions, policy outcomes, action results, and workflow transitions; snapshots and projections SHALL be rebuildable from that event sequence.

#### Scenario: State is rebuilt after restart
- **WHEN** the process restarts after a workflow transition has been appended
- **THEN** replaying the events reconstructs the same BehaviorContext and workflow step without relying on in-memory conversation history

### Requirement: BehaviorContext preserves critical execution state
The current behavior state SHALL preserve subject identity and reference provenance, intent, action, Function, selected Plugin, slots, workflow step, pending input, confirmation state, idempotency key, and integrity metadata.

#### Scenario: Reference resolution survives later input
- **WHEN** a previous event resolves “第一个服务” to stable subject `test1`
- **THEN** a later input can recover `subject.id=test1` and the source event without reinterpreting the original list

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
