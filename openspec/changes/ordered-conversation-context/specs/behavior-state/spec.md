# Spec Delta

## ADDED Requirements

### Requirement: Behavior state projects completed conversation turns

The behavior projection SHALL retain a bounded ordered history of completed user-and-assistant turn pairs with stable IDs, outcome metadata and a current turn focus, without treating message text as execution authority.

#### Scenario: Replay reconstructs turn order

- **WHEN** the same accepted turn events are replayed after a session restart
- **THEN** the projection produces the same turn IDs, sequence numbers, pair boundaries and focus turn

#### Scenario: Partial stream is not projected as final

- **WHEN** a turn ends before a final assistant reply is committed
- **THEN** replay does not expose that partial reply as a completed turn pair

### Requirement: Turn projection is bounded and session-scoped

The projection SHALL enforce configured bounds and session ownership for turn records, reject invalid sequence transitions, and preserve earlier records when a later turn is appended.

#### Scenario: Invalid turn event is rejected

- **WHEN** an event has a foreign session, duplicate turn ID or non-increasing sequence
- **THEN** projection rejects the update and retains the last valid state

#### Scenario: Turn history reaches its bound

- **WHEN** the number of completed turns exceeds the configured limit
- **THEN** the projection removes only the oldest bounded turn records and retains the newest ordered focus

### Requirement: Conversation focus and fact focus are independent

The behavior state SHALL preserve separate optional focus IDs for conversation turns and verified facts, and resolving one focus SHALL not mutate the other collection.

#### Scenario: Context selection changes only its scope

- **WHEN** a semantic reference selects a prior conversation turn
- **THEN** the conversation focus may update while the verified fact focus remains unchanged
