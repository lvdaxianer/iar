# response-observability Specification

## Purpose
为一次 IAR 会话轮次提供可读、可关联且不泄露业务内容的时间线，使用户能看到总耗时，运维人员能通过结构化日志和 Trace 定位具体慢点。

## Requirements

### Requirement: A turn exposes bounded timing milestones

The runtime SHALL assign one trace identifier to each accepted turn and expose bounded start, end, duration, status and safe metadata for the turn and its applicable milestones.

#### Scenario: Completed turn exposes total and stage timings
- **WHEN** a turn completes normally
- **THEN** the host-facing result contains total duration and the durations of completed semantic, routing, execution and response stages when those stages occurred

#### Scenario: Failed turn preserves completed timings
- **WHEN** a turn fails, times out or is interrupted after one or more stages
- **THEN** the host-facing error retains the trace identifier and completed stage timings without claiming an unfinished stage succeeded

### Requirement: Timing summaries are streamed to the host

The runtime SHALL stream one bounded timing summary before the turn-complete event (or before a stream error) without exposing prompts, model payloads or secrets. The summary may include measured first-token latency for applicable response stages.

#### Scenario: First response token is measured
- **WHEN** the response model emits its first answer token
- **THEN** the host receives the measured first-token latency in the timing summary without receiving raw model payloads

#### Scenario: A slow stage remains visible
- **WHEN** a stage exceeds its configured slow threshold
- **THEN** the host receives that stage's status and elapsed duration in the timing summary even if no later stage started

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

### Requirement: Logs obey safety and reliability boundaries

The runtime SHALL enforce field allowlists, global redaction, bounded metadata, trace propagation through asynchronous work and fail-open log delivery; DEBUG diagnostics SHALL be switchable without restarting the process.

#### Scenario: Sensitive data is supplied to a log call
- **WHEN** a log input contains a credential, token, password, raw prompt or raw model response
- **THEN** the emitted record excludes or redacts the value and keeps only the approved safe summary

#### Scenario: Log output fails
- **WHEN** the log sink is full, stalls or returns an error
- **THEN** the business turn continues, the sink records bounded failure counters and no unbounded queue is created

#### Scenario: Debug is switched at runtime
- **WHEN** an authorized runtime debug switch changes level
- **THEN** subsequent diagnostic records follow the new setting without a process restart and keep the same safety limits

### Requirement: Telemetry concerns remain separated

The runtime SHALL use logs for event summaries and trace identifiers, while leaving high-frequency numeric distributions to metrics and compliance events to audit records; no one channel SHALL be required to reconstruct another channel's purpose.

#### Scenario: A trace identifier is correlated with logs
- **WHEN** a turn has multiple stages and model calls
- **THEN** each stage log summary carries the same safe trace correlation without requiring raw payload logging
