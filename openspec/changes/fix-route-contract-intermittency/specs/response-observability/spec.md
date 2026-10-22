# Spec Delta

## MODIFIED Requirements

### Requirement: Structured logs use bilingual human-readable labels

Operational log records SHALL retain stable English machine fields and SHALL provide Chinese and English labels for the phase, model role, duration, status and outcome in human-readable output. Contract validation records SHALL additionally include bounded expected and actual values, a stable reason code and the execution decision. The selected output format SHALL be resolved after supported environment configuration has been loaded and before the first operational record is emitted.

#### Scenario: A normal milestone is logged

- **WHEN** a turn reaches a normal business milestone
- **THEN** an INFO record includes trace correlation, the stable phase value and bilingual readable labels with bounded timing metadata

#### Scenario: A timeout is classified

- **WHEN** a model, bridge or stage times out
- **THEN** a WARN record identifies the timeout class and stage without recording request bodies, response bodies or credentials

#### Scenario: A contract failure includes expected and actual values

- **WHEN** the model returns a missing, illegal or conflicting Function-call identity
- **THEN** a WARN record includes the trace ID, stage, model role, selected Plugin/Function IDs, expected value, actual value, reason code and whether execution was blocked

#### Scenario: Pretty format is configured through the environment

- **WHEN** the process starts with `IAR_LOG_FORMAT=pretty` or loads that value from its supported environment file
- **THEN** the first and subsequent operational records use the bilingual human-readable writer instead of JSON

### Requirement: Logs obey safety and reliability boundaries

The runtime SHALL enforce field allowlists, global redaction, bounded metadata, trace propagation through asynchronous work and fail-open log delivery; DEBUG diagnostics SHALL be switchable without restarting the process. Contract diagnostics SHALL log only safe identifiers and bounded expected/actual values, never raw user text or model payloads.

#### Scenario: Sensitive data is supplied to a log call

- **WHEN** a log input contains a credential, token, password, raw prompt or raw model response
- **THEN** the emitted record excludes or redacts the value and keeps only the approved safe summary

#### Scenario: Log output fails

- **WHEN** the log sink is full, stalls or returns an error
- **THEN** the business turn continues, the sink records bounded failure counters and no unbounded queue is created

#### Scenario: Debug is switched at runtime

- **WHEN** an authorized runtime debug switch changes level
- **THEN** subsequent diagnostic records follow the new setting without a process restart and keep the same safety limits

## ADDED Requirements

### Requirement: Contract diagnostics are visible at the response boundary

The host-facing failure result SHALL retain the trace ID and stable contract reason code, and the Sandbox SHALL expose a bounded bilingual diagnostic summary without exposing raw model output.

#### Scenario: Operation contract failure reaches the host

- **WHEN** route validation blocks a proposal because operation is missing, illegal or conflicting
- **THEN** the host result includes the trace ID, reason code and completed stage timings, while the user-facing message explains the next safe action

#### Scenario: Diagnostic fields are absent

- **WHEN** a response has no contract failure
- **THEN** the host preserves the existing status/source metadata and does not render fabricated expected or actual values
