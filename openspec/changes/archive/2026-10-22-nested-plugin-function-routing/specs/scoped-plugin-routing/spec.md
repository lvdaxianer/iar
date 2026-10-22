# Spec Delta

## MODIFIED Requirements

### Requirement: Plugin scope precedes action filtering

The primary Agent routing path SHALL expose only bounded Plugin-level tools, with each selected Plugin carrying its own current Function and Operation candidates as nested data. The primary path SHALL NOT expose a cross-Plugin flattened Function list or require a separate Plugin-selection model call.

#### Scenario: First route sees nested Plugin tools

- **WHEN** an Agent has multiple enabled business Plugins with one or more Functions each
- **THEN** the route model receives one bounded tool per Plugin with nested Function/Operation candidates and does not receive a cross-Plugin flattened Function list

#### Scenario: First stage sees Plugin descriptions only

- **WHEN** an Agent has multiple enabled business Plugins with one or more Functions each
- **THEN** `semantic.extract` receives one bounded description per Plugin and does not receive Function input/output Schemas or a cross-Plugin Function candidate list

#### Scenario: Complete proposal is resolved by runtime

- **WHEN** the model proposes a Plugin tool, nested Function/Operation and named arguments
- **THEN** the runtime revalidates the Plugin and resolves only the matching installed Function registration

#### Scenario: Selected Plugin narrows Function candidates

- **WHEN** semantic extraction proposes an enabled authorized Plugin
- **THEN** the runtime revalidates that Plugin and provides only its current Functions to `function.call`

#### Scenario: Invalid nested proposal is non-authoritative

- **WHEN** the model returns an unknown, disabled, unauthorized or action-incompatible Plugin, Function or Operation
- **THEN** the runtime rejects or falls back to a bounded response path and does not load or execute the proposed registration

#### Scenario: Invalid Plugin proposal is non-authoritative

- **WHEN** the semantic model returns an unknown, disabled, unauthorized or action-incompatible Plugin ID
- **THEN** the runtime rejects or falls back to a bounded response path and does not load or execute a Function from that proposal

#### Scenario: Query does not create an unbounded flat candidate list

- **WHEN** ten Plugin packages each expose a query-compatible Function
- **THEN** the route request contains ten bounded Plugin tools with nested candidates, and no separately flattened cross-Plugin Function list

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugin packages each expose a `query`-compatible Function and the current input has no active Function scope
- **THEN** the first semantic decision receives only bounded Plugin descriptions, and no Function implementation is loaded before Plugin validation succeeds

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Plugin and no active scope exists
- **THEN** the runtime asks a clarification question without selecting a Plugin or expanding executable candidates from unrelated packages

#### Scenario: Agent-disabled Plugin is excluded before routing

- **WHEN** an Agent creation configuration disables a Plugin that would otherwise match the current input
- **THEN** that Plugin and its nested Functions are absent from semantic/routing candidates, model context and self-introduction metadata and cannot be selected by a model

### Requirement: Plugin packages own Function scope

The runtime SHALL derive every Function and Operation candidate from the selected Plugin package's validated nested registrations. Legacy Function-first decision adapters MAY remain available for compatibility but SHALL NOT widen the primary nested Plugin tool path.

#### Scenario: Function routing uses package registrations

- **WHEN** a Plugin package exposes `knowledge.query` and `report.center`
- **THEN** both Function candidates are nested under that package's Plugin tool and Plugin selection for either candidate is restricted to the package's matching registration

#### Scenario: Multiple providers share a Function

- **WHEN** two enabled Plugin packages expose `ticket.query`
- **THEN** each Plugin tool retains its own bounded Function identity and the runtime never resolves one provider through the other provider's tool

### Requirement: The primary route uses bounded model stages

The primary route SHALL use at most one model proposal call and one response generation call when a model response is required. It SHALL NOT call a separate Plugin-selection model after the nested proposal.

#### Scenario: Normal query has two model stages

- **WHEN** a user asks for a query handled by an enabled Plugin and the Function result uses `model` response mode
- **THEN** the runtime performs one nested route proposal and one `response.generate` call in that order

#### Scenario: Normal query has three model stages

- **WHEN** a user asks for a query handled by an enabled Plugin and the Function result uses `model` response mode
- **THEN** the runtime performs `semantic.extract`, `function.call`, and `response.generate` in that order

#### Scenario: Direct or none result skips response generation

- **WHEN** the selected Function returns a validated `direct` or `none` result for an allowed non-query operation
- **THEN** the runtime does not call `response.generate`
