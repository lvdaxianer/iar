# Spec Delta

## ADDED Requirements

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
