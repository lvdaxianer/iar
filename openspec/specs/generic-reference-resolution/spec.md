# Generic Reference Resolution

## Purpose

为模型抽取的自然语言关系提供不带业务属性的有序事实候选解析、可恢复消歧、安全兜底和动态能力选择，并确保候选状态可重放且不会改变执行授权边界。

## Requirements

### Requirement: Relation extraction is business-neutral

The runtime SHALL accept only the generic relation vocabulary, optional opaque record anchor and bounded offset from semantic extraction; it SHALL NOT require or generate business-specific entity fields to resolve a reference.

#### Scenario: A model extracts a relative reference

- **WHEN** the model returns a `previous` relation with an opaque anchor record ID
- **THEN** the runtime resolves it against the ordered verified fact chain without interpreting any fact value as an identifier

#### Scenario: A legacy business target is returned

- **WHEN** a model response places a business value in the historical reference target instead of a relation and opaque anchor
- **THEN** contract validation rejects the response and no route or side effect starts

### Requirement: Ambiguous relations produce bounded candidates

The runtime SHALL return a finite ordered candidate set when a relation cannot be deterministically anchored, and SHALL preserve the candidate record IDs without changing the verified fact history.

#### Scenario: Missing anchor has multiple possible records

- **WHEN** a relative relation has no valid focus or explicit anchor and multiple records can satisfy it
- **THEN** the runtime returns an ambiguous result containing only bounded opaque record IDs and does not choose one silently

#### Scenario: Explicit relation is deterministic

- **WHEN** `first`, `last`, or an anchored bounded relation identifies one record
- **THEN** the runtime returns exactly that verified record and leaves all prior records unchanged

### Requirement: Pending reference state is recoverable and non-authoritative

The session SHALL persist the original generic relation and bounded candidate record IDs in BehaviorContext and replay them through the clarification event and snapshot path; pending reference state SHALL NOT authorize a Function, Plugin or side effect.

#### Scenario: Ambiguous state survives replay

- **WHEN** a reference produces candidates and the session is restored
- **THEN** the same pending relation and candidate IDs are available before the next model decision

#### Scenario: Pending candidates cannot execute

- **WHEN** a user message matches or mentions a pending candidate without a new validated route and policy decision
- **THEN** the runtime remains in clarification and does not execute an action

### Requirement: Repeated failure has a generic recovery path

After bounded unresolved attempts, the runtime SHALL ask the user to choose from current runtime-provided capability descriptors or otherwise request a new clarification, without embedding business feature names in core code.

#### Scenario: Repeated reference failure escalates

- **WHEN** reference resolution repeatedly fails to converge
- **THEN** the runtime presents a finite selection derived from current Plugin descriptors and retains no stale executable choice

### Requirement: Model context preserves both sources

Semantic extraction and response generation SHALL receive the validated BehaviorContext including pending reference state, bounded candidate facts and the bounded recent raw-message window as separate non-authoritative input sources.

#### Scenario: Response model receives ambiguity context

- **WHEN** a relation is ambiguous
- **THEN** response generation receives the generic pending reference, candidate facts and recent messages, while no action execution is attempted
