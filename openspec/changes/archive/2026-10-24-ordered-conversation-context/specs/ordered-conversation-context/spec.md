# Spec Delta

## Purpose

让会话以可恢复、可验证的有序轮次表达用户问题和助手回答，使模型能够区分对话引用与业务事实引用，并在刷新或重启后保持同一顺序。

## ADDED Requirements

### Requirement: Conversation turns are ordered pairs

The system SHALL represent one conversation turn as one user input paired with its final assistant reply, with a stable turn ID and increasing sequence number.

#### Scenario: A completed turn is recorded

- **WHEN** the runtime finishes processing one user input
- **THEN** the session exposes one ordered turn containing that user input, the final assistant reply and the bounded outcome summary

#### Scenario: Incomplete output is not a final pair

- **WHEN** a streaming response is interrupted before a final reply is committed
- **THEN** the runtime does not present the partial output as the completed assistant reply for that turn

### Requirement: Conversation turns survive session recovery

The system SHALL persist and restore a bounded ordered turn history using the session identity, without promoting raw turn text to trusted execution facts.

#### Scenario: The next request follows a restart

- **WHEN** a session is resumed after its latest valid snapshot and message writes are available
- **THEN** the next model input receives the same ordered completed turns before processing the new user input

#### Scenario: Sessions remain isolated

- **WHEN** two sessions have overlapping turn sequences or similar user text
- **THEN** each session receives only its own turns

### Requirement: Turn references use an explicit scope

The system SHALL allow semantic model output to reference a conversation turn by scope, stable ID, sequence or finite relation, and SHALL validate that the selected target exists in the current session.

#### Scenario: A relative question reference resolves

- **WHEN** the model identifies the user request as referring to a prior conversation question
- **THEN** the runtime resolves it against ordered conversation turns and does not search the business fact chain for that target

#### Scenario: An invalid turn target is returned

- **WHEN** the model returns a missing, foreign or out-of-range turn target
- **THEN** the runtime rejects the reference, keeps it non-authoritative and asks for bounded clarification without executing a Function

### Requirement: Ordered turns and facts remain distinct

The system SHALL expose conversation turns and verified business facts as separate ordered collections, each with its own focus and sequence namespace.

#### Scenario: Question and ticket references coexist

- **WHEN** a user asks about a prior question and later asks about a prior ticket
- **THEN** the runtime resolves each reference in the collection selected by the model scope and preserves both collection orders
