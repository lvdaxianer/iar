# Pi Host Entry Rendering

## Purpose

This capability keeps the Pi host demo's IAR activity observable by rendering
the payload carried by each validated bridge entry rather than its transport
envelope.

## Requirements

### Requirement: Render IAR bridge entry payloads

The Pi host demo SHALL render the `data` payload of an SSE entry whose
`customType` is `iar-bridge`, including its disposition and content.

#### Scenario: Handled IAR result is visible

- **WHEN** the host emits an `iar-bridge` entry envelope with a handled
  disposition and response content
- **THEN** the page renders the disposition and response content from the
  envelope's `data` object

#### Scenario: Unrelated entry is ignored

- **WHEN** the page receives an SSE entry with a different `customType`
- **THEN** the page does not render it as an IAR result

#### Scenario: Malformed entry does not break the stream

- **WHEN** the page receives an `iar-bridge` entry without an object payload
- **THEN** the page ignores that entry and remains available for later valid
  entries
