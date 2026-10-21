# Delta for response-observability

## ADDED Requirements

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
