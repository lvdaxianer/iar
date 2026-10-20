# Spec Delta

## ADDED Requirements

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
