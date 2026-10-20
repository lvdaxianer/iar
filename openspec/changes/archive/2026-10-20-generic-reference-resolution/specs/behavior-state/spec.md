# Behavior State Delta

## ADDED Requirements

### Requirement: BehaviorContext preserves pending generic references

The projected behavior state SHALL preserve a bounded pending reference containing only the original relation, optional opaque anchor metadata and candidate record IDs, and SHALL replay it deterministically with the clarification event and snapshot.

#### Scenario: Pending reference is restored

- **WHEN** a session is restarted after an ambiguous historical reference
- **THEN** the pending reference and its candidate record IDs are available before the next decision

#### Scenario: Pending reference cannot alter authority

- **WHEN** a pending reference is present without a new route and policy result
- **THEN** it remains data-only and cannot authorize execution
