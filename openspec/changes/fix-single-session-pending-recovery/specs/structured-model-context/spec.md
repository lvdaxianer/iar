# Spec Delta

## MODIFIED Requirements

### Requirement: Compaction preserves the distinction between facts and actions

Compaction SHALL preserve enough validated action/result provenance for the next
turn to distinguish a historical read/status question from a new side-effecting
request. A generated summary or incomplete model frame SHALL never authorize a
new action.

#### Scenario: Status reference after compaction uses the verified result

- **WHEN** a confirmed limit result is retained in structured context and the
  user asks for its status after compaction
- **THEN** the response is bound to that result and no second confirmation is
  created
