# Spec Delta

## ADDED Requirements

### Requirement: Model inputs expose separate ordered context collections

The system SHALL provide bounded conversation turns and verified fact records as separate ordered model input fields, including stable IDs, sequence numbers, current focus and outcome metadata.

#### Scenario: Response generation receives both orders

- **WHEN** a response model answers a question that may refer to prior dialogue or a business result
- **THEN** its input contains the ordered conversation turns and ordered verified facts in separate fields

#### Scenario: Model input is bounded

- **WHEN** the session exceeds its configured context limits
- **THEN** each collection is truncated by its own documented bound without merging, reordering or replacing one collection with the other

### Requirement: Model references select a validated context scope

The semantic contract SHALL let the model identify whether a historical reference targets a conversation turn or a verified fact, while Runtime SHALL validate the selected ID, sequence, relation and session ownership before use.

#### Scenario: A question ordinal targets a turn

- **WHEN** the user asks for a numbered prior question and the model selects the conversation-turn scope
- **THEN** Runtime resolves the requested turn sequence and passes only that validated turn as the reference

#### Scenario: A fact ordinal targets a business record

- **WHEN** the user asks for a numbered prior business record and the model selects the fact scope
- **THEN** Runtime resolves the record sequence in the verified fact chain without using conversation-message order

### Requirement: Natural-language understanding is model-owned

The runtime SHALL not require a fixed keyword list to classify relative, ordinal or corrective context language; it SHALL use the model's structured scope and relation output, then enforce only schema, bounds, authority and execution checks.

#### Scenario: Equivalent wording shares one contract

- **WHEN** users express the same context reference with different natural-language wording
- **THEN** the runtime applies the same validated scope and relation contract without adding a new business-specific lexical branch

#### Scenario: Context answer cannot authorize execution

- **WHEN** the semantic model marks a request as an answer from prior context
- **THEN** Runtime may pass the validated reference to response generation but does not prepare or execute a side-effecting Function from that reference alone

### Requirement: Ordered context is authoritative over raw message order

The response model SHALL use Runtime-provided sequence and ID metadata for historical selection and SHALL not infer a different order from bounded raw messages or reorder verified facts by business fields.

#### Scenario: Raw messages disagree with a fact sequence

- **WHEN** recent raw messages display facts in a different presentation order than the verified fact collection
- **THEN** the response model uses the verified sequence order and does not silently substitute the raw-message order
