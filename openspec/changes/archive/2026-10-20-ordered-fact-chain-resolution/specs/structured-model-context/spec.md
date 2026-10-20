# Spec Delta

## ADDED Requirements

### Requirement: Verified facts are retained as an ordered bounded history
The system SHALL append each accepted verified fact result as a distinct bounded record with an opaque record ID, sequence position, source event, dynamic Function/Plugin identifiers and declared values, without replacing an earlier record that shares a field key.

#### Scenario: Repeated results remain addressable
- **WHEN** two successful actions expose the same declared field key in one session
- **THEN** both verified records remain available in chronological order with distinct record IDs

#### Scenario: Failed result is not appended as trusted history
- **WHEN** an action fails, is rejected, or is not confirmed
- **THEN** no successful verified fact record is appended for that outcome

#### Scenario: Duplicate event replay is idempotent
- **WHEN** the same accepted source event is projected more than once
- **THEN** the projection retains one corresponding fact record rather than appending a duplicate

### Requirement: Historical references use a generic relation contract
The system SHALL allow the semantic model to express a historical reference using an existing opaque record ID, a finite relation, and an optional scope; the model output SHALL not contain a business-specific lookup rule or authorize an action.

#### Scenario: Previous record is requested
- **WHEN** the current message means “this result's previous one” and a current focus record exists
- **THEN** the semantic result contains the focus record ID and the generic `previous` relation

#### Scenario: Model cannot invent a target record
- **WHEN** the semantic model returns a record ID that is not present in the session history
- **THEN** the runtime rejects the reference and does not use the invented ID as a fact or execution input

#### Scenario: Relation does not authorize side effects
- **WHEN** a valid historical relation resolves to a prior record
- **THEN** the runtime may answer or prepare a read-only interpretation, but it still requires the normal route, policy and confirmation gates for any side effect

### Requirement: Unresolved historical references receive bounded dynamic clarification
The system SHALL fail closed when a historical reference has no valid anchor, no target, or multiple valid interpretations, and SHALL generate bounded clarification options from current runtime data or Plugin descriptors without hardcoded business choices.

#### Scenario: No anchor is available
- **WHEN** the user says “上一个” but no focus or valid anchor record exists
- **THEN** the runtime asks for a bounded clarification and does not execute an action

#### Scenario: Multiple records are plausible
- **WHEN** the relation cannot identify one target record deterministically
- **THEN** the runtime presents runtime-generated choices or asks the user to restate the reference, without selecting a business-specific default

#### Scenario: Repeated unresolved input reaches the fallback threshold
- **WHEN** unresolved reference attempts reach the configured bounded threshold
- **THEN** the runtime offers a dynamic function/plugin selection or safe retry response and resets or preserves state according to the configured escalation result
