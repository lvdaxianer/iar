# Spec Delta

## MODIFIED Requirements

### Requirement: Structured logs use bilingual human-readable labels

Operational log records SHALL retain stable English machine fields and SHALL provide Chinese and English labels for the phase, model role, duration, status and outcome in human-readable output. The selected output format SHALL be resolved after supported environment configuration has been loaded and before the first operational record is emitted.

#### Scenario: A normal milestone is logged
- **WHEN** a turn reaches a normal business milestone
- **THEN** an INFO record includes trace correlation, the stable phase value and bilingual readable labels with bounded timing metadata

#### Scenario: A timeout is classified
- **WHEN** a model, bridge or stage times out
- **THEN** a WARN record identifies the timeout class and stage without recording request bodies, response bodies or credentials

#### Scenario: Pretty format is configured through the environment
- **WHEN** the process starts with `IAR_LOG_FORMAT=pretty` or loads that value from its supported environment file
- **THEN** the first and subsequent operational records use the bilingual human-readable writer instead of JSON
