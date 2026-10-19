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
