# Spec Delta

## MODIFIED Requirements

### Requirement: Plugin scope precedes action filtering

The primary Agent routing path SHALL first give the semantic model only bounded Plugin-level descriptions and accept at most an untrusted Plugin proposal. After runtime filtering and revalidation, the Function stage SHALL receive only the selected Plugin's current Function definitions and input Schemas. The primary path SHALL NOT expose a cross-Plugin flattened Function list to the first model call.

#### Scenario: First stage sees Plugin descriptions only

- **WHEN** an Agent has multiple enabled business Plugins with one or more Functions each
- **THEN** `semantic.extract` receives one bounded description per Plugin and does not receive Function input/output Schemas or a cross-Plugin Function candidate list

#### Scenario: Selected Plugin narrows Function candidates

- **WHEN** semantic extraction proposes an enabled authorized Plugin
- **THEN** the runtime revalidates that Plugin and provides only its current Functions to `function.call`

#### Scenario: Invalid Plugin proposal is non-authoritative

- **WHEN** the semantic model returns an unknown, disabled, unauthorized or action-incompatible Plugin ID
- **THEN** the runtime rejects or falls back to a bounded response path and does not load or execute a Function from that proposal

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugin packages each expose a `query`-compatible Function and the current input has no active Function scope
- **THEN** the first semantic decision receives only bounded Plugin descriptions, and no Function implementation is loaded before Plugin validation succeeds

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Plugin and no active scope exists
- **THEN** the runtime asks a clarification question without selecting a Plugin or expanding executable candidates from unrelated packages

#### Scenario: Agent-disabled Plugin is excluded before routing

- **WHEN** an Agent creation configuration disables a Plugin that would otherwise match the current input
- **THEN** that Plugin and its Functions are absent from semantic/routing candidates, model context and self-introduction metadata and cannot be selected by a model

### Requirement: Plugin packages own Function scope

The runtime SHALL derive every Function tool and execution candidate from the selected Plugin package's validated nested registrations. Legacy Function-first decision adapters MAY remain available for compatibility but SHALL NOT widen the new Plugin-first path.

#### Scenario: Multiple Functions stay inside one package

- **WHEN** one Plugin owns `ticket.query` and `ticket.create`
- **THEN** the Function stage receives both only after that Plugin is selected, and the model cannot see Functions from unrelated Plugins

#### Scenario: Function routing uses package registrations

- **WHEN** a Plugin package exposes `knowledge.query` and `report.center`
- **THEN** both Function candidates are derived from that package and Plugin selection for either candidate is restricted to the package's matching registration

#### Scenario: Multiple providers share a Function

- **WHEN** two enabled Plugin packages expose `ticket.query`
- **THEN** the Function stage retains one bounded Function identity and the Plugin stage receives only those two matching providers

### Requirement: Agent-disabled Plugins are excluded before both stages

The Agent-level disabled Plugin set SHALL be applied before Plugin descriptions, semantic model context, Function tools, self-introduction metadata and fallback capability context are built.

#### Scenario: Disabled Plugin cannot be reintroduced

- **WHEN** a disabled Plugin is named by semantic extraction or Function Calling
- **THEN** the runtime rejects it using the current registry state and does not execute or describe it as available

## ADDED Requirements

### Requirement: The primary route uses bounded model stages

The primary route SHALL use one semantic/Plugin proposal call, at most one Function-call proposal call, and one response generation call when a model response is required. It SHALL NOT call a separate Plugin selection model after the semantic proposal.

#### Scenario: Normal query has three model stages

- **WHEN** a user asks for a query handled by an enabled Plugin and the Function result uses `model` response mode
- **THEN** the runtime performs `semantic.extract`, `function.call`, and `response.generate` in that order

#### Scenario: Direct or none result skips response generation

- **WHEN** the selected Function returns a validated `direct` or `none` result for an allowed non-query operation
- **THEN** the runtime does not call `response.generate`
