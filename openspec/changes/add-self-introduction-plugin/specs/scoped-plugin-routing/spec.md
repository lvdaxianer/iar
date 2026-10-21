# Spec Delta

## MODIFIED Requirements

### Requirement: Plugin scope precedes action filtering

The registration model SHALL derive every routable Function scope from an installed Plugin package, while the existing routing protocol SHALL first select a finite Function and then select a Plugin implementation within that Function. An `actionType` SHALL only filter Functions and Plugin candidates inside the current finite routing scope, and an Agent-level disabled Plugin set SHALL be applied before model candidates and self-introduction metadata are constructed.

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugin packages each expose a `query`-compatible Function and the current input has no active Function scope
- **THEN** the first decision receives the same finite Function candidates derived from registered packages, and no Plugin implementation is selected before the Function decision succeeds

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Function and no active scope exists
- **THEN** the runtime asks a clarification question without selecting a Plugin or expanding executable candidates from unrelated packages

#### Scenario: Agent-disabled Plugin is excluded before routing

- **WHEN** an Agent creation configuration disables a Plugin that would otherwise match the current input
- **THEN** that Plugin and its Functions are absent from semantic/routing candidates and cannot be selected by a model

### Requirement: Routing decisions remain non-authoritative

Plugin and action decisions SHALL remain finite model recommendations; final registry, authorization, policy, capability, confirmation, and enabled-state checks SHALL still run before execution. System Plugin packages SHALL not enter business routing candidates. Agent-level disabled Plugin configuration SHALL be enforced by the runtime registry and SHALL NOT be overridable by model output or self-introduction prompt text.

#### Scenario: Model cannot grant execution authority

- **WHEN** a model proposes a disabled, unauthorized, or policy-incompatible Function or Plugin
- **THEN** the runtime rejects the proposal before execution and records the stable rejection reason

#### Scenario: Prompt cannot re-enable a disabled Plugin

- **WHEN** self-introduction supplementary text requests that a disabled Plugin be included or used
- **THEN** the runtime keeps the Plugin unavailable and returns only the currently allowed capability inventory
