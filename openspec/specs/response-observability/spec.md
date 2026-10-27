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

### Requirement: Contract diagnostics are visible at the response boundary

The host-facing failure result SHALL retain the trace ID and stable contract reason code, and the Sandbox SHALL expose a bounded bilingual diagnostic summary without exposing raw model output.

#### Scenario: Operation contract failure reaches the host

- **WHEN** route validation blocks a proposal because operation is missing, illegal or conflicting
- **THEN** the host result includes the trace ID, reason code and completed stage timings, while the user-facing message explains the next safe action

#### Scenario: Diagnostic fields are absent

- **WHEN** a response has no contract failure
- **THEN** the host preserves the existing status/source metadata and does not render fabricated expected or actual values

### Requirement: Telemetry concerns remain separated

The runtime SHALL use logs for event summaries and trace identifiers, while leaving high-frequency numeric distributions to metrics and compliance events to audit records; no one channel SHALL be required to reconstruct another channel's purpose.

#### Scenario: A trace identifier is correlated with logs
- **WHEN** a turn has multiple stages and model calls
- **THEN** each stage log summary carries the same safe trace correlation without requiring raw payload logging

### Requirement: Timing summaries are visible at the response boundary

The Sandbox and Pi host pages SHALL render the server-provided turn timing summary at both the response message boundary and the detailed Timing panel when a timing summary is available.

#### Scenario: Completed response shows duration and trace correlation

- **WHEN** a response completes with `durationMs` and `traceId`
- **THEN** the message footer shows a human-readable duration and a shortened trace identifier, while the Timing panel retains the full trace identifier and stage durations

#### Scenario: Timing data is absent or incomplete

- **WHEN** a response completes without timing data or without one of the optional timing fields
- **THEN** the page preserves the existing status/source meta and does not render fabricated duration or undefined trace text

#### Scenario: Pi host finishes an entry after timing arrives

- **WHEN** Pi host receives a timing event before the corresponding entry or streamed response completes
- **THEN** that timing summary is attached only to the current response and is cleared before the next user turn

### Requirement: Bridge client timeout is bounded and configurable

The Pi Bridge client SHALL accept an optional environment-based request timeout, use a documented default when it is absent, reject non-positive or excessive values, and classify expiry as a bridge timeout without exposing upstream payloads.

#### Scenario: Configured timeout is used
- **WHEN** the host starts with a valid Bridge timeout environment value
- **THEN** every Bridge HTTP request uses that bounded timeout

#### Scenario: Missing timeout uses the default
- **WHEN** no Bridge timeout environment value is configured
- **THEN** the client uses its documented default and preserves existing request behavior

#### Scenario: Invalid timeout fails safely
- **WHEN** the timeout value is malformed, non-positive, or exceeds the maximum
- **THEN** startup or client construction rejects the configuration with a stable configuration error and does not make a Bridge request

#### Scenario: Bridge expiry is distinguished from model failure
- **WHEN** the client-side Bridge deadline expires before an HTTP response is received
- **THEN** the host receives the stable Bridge-timeout classification, while a server-returned model failure keeps its model-failure classification

### Requirement: Semantic extraction diagnostics identify the blocking field

The runtime SHALL emit a trace-correlated safe diagnostic after semantic extraction that records bounded field-presence status, action classification, candidate scope size and the next routing gate without recording raw text or model payloads.

#### Scenario: Extraction omits an execution field
- **WHEN** semantic extraction completes with an absent or unknown field needed for routing
- **THEN** the log contains the trace ID, extraction status, missing-field reason and the fact that route proposal and execution were skipped

#### Scenario: Extraction is complete
- **WHEN** semantic extraction returns a valid bounded frame
- **THEN** the log contains the trace ID, safe action classification and the next route stage, and does not expose the prompt or response body

### Requirement: Route diagnostics distinguish each stop boundary

The runtime SHALL emit a stable route diagnostic for candidate filtering, route proposal, contract validation, confirmation waiting, execution and bridge failure, with expected and actual safe identifiers only where applicable.

#### Scenario: Model proposal is absent
- **WHEN** route proposal returns no valid proposal or is skipped because the semantic frame is incomplete
- **THEN** the diagnostic identifies the route boundary and reason, and the timing summary does not claim action execution

#### Scenario: Bridge fails before routing completes
- **WHEN** the bridge times out, returns an invalid response or becomes unavailable
- **THEN** the diagnostic classifies the failure separately from semantic incompleteness and preserves the same trace ID
