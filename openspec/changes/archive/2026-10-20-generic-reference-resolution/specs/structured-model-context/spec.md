# Structured Model Context Delta

## ADDED Requirements

### Requirement: Ambiguous historical references are supplied as bounded model data

The system SHALL provide pending generic reference metadata and its bounded verified candidate records to semantic extraction and response generation, while keeping recent raw messages separate and non-authoritative.

#### Scenario: Ambiguity is clarified without a side effect

- **WHEN** the runtime cannot select one historical record
- **THEN** the model receives the candidate records and current message, and the runtime does not prepare or execute a Function
