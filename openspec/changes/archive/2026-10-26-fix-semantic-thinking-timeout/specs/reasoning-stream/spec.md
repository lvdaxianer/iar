# Spec Delta

## MODIFIED Requirements

### Requirement: Intent extraction does not expose reasoning

Semantic extraction and routing model calls SHALL disable reasoning output and SHALL expose only their validated structured decision results to the runtime and host.

#### Scenario: Intent extraction completes

- **WHEN** the intent model returns a semantic decision
- **THEN** no reasoning event is sent to the host and only the validated decision and timing metadata are available