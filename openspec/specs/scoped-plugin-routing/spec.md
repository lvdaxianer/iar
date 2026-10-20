# scoped-plugin-routing Specification

## Purpose

将 Plugin 业务范围、固定动作类型和 Function 选择组织成有限、可持续收敛的路由过程，避免按 `query` 或 `create` 在所有 Plugin 之间无界扩展候选。

## Requirements

### Requirement: Plugin scope precedes action filtering

The registration model SHALL derive every routable Function scope from an installed Plugin package, while the existing routing protocol SHALL first select a finite Function and then select a Plugin implementation within that Function. An `actionType` SHALL only filter Functions and Plugin candidates inside the current finite routing scope.

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugin packages each expose a `query`-compatible Function and the current input has no active Function scope
- **THEN** the first decision receives the same finite Function candidates derived from registered packages, and no Plugin implementation is selected before the Function decision succeeds

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Function and no active scope exists
- **THEN** the runtime asks a clarification question without selecting a Plugin or expanding executable candidates from unrelated packages

### Requirement: Function manifests declare fixed action types

Every routable Function registration inside a Plugin package SHALL declare a bounded list of fixed action types, and the runtime SHALL reject unknown or malformed action types before candidate construction.

#### Scenario: Action narrows a selected Plugin

- **WHEN** the selected Plugin contains `query`, `create`, and `update` Functions and the decision returns `query`
- **THEN** only the Plugin's query-compatible Function registrations continue to the next route stage

### Requirement: Session routing scope is stateful

The structured session context SHALL preserve the active Plugin, bounded candidate Plugin IDs, continuation state, and pending route information. A follow-up SHALL reuse the active scope; a new or explicitly switched intent SHALL replace it; ambiguous short input SHALL retain the scope and request clarification.

#### Scenario: Short follow-up keeps the Plugin scope

- **WHEN** a session has active Plugin `human-service` and the user asks “我排第几位”
- **THEN** routing reuses the active Plugin scope and its registered Functions without rescanning unrelated Plugin packages

#### Scenario: Explicit domain switch replaces the scope

- **WHEN** the session is in `human-service` and the user asks to query an order
- **THEN** the Function decision can replace the route scope and the Plugin decision then evaluates only order-related implementations

### Requirement: Routing decisions remain non-authoritative

Plugin and action decisions SHALL remain finite model recommendations; final registry, authorization, policy, capability, confirmation, and enabled-state checks SHALL still run before execution. System Plugin packages SHALL not enter business routing candidates.

#### Scenario: Model cannot grant execution authority

- **WHEN** a model proposes a disabled, unauthorized, or policy-incompatible Function or Plugin
- **THEN** the runtime rejects the proposal before execution and records the stable rejection reason

### Requirement: Plugin packages own Function scope

The runtime SHALL derive Function ownership and Plugin candidate relationships from validated nested registrations rather than from a separate caller-maintained Function ownership list.

#### Scenario: Function routing uses package registrations

- **WHEN** a Plugin package exposes `knowledge.query` and `report.center`
- **THEN** both Function candidates are derived from that package and Plugin selection for either candidate is restricted to the package's matching registration

#### Scenario: Multiple providers share a Function

- **WHEN** two enabled Plugin packages expose `ticket.query`
- **THEN** the Function stage retains one bounded Function identity and the Plugin stage receives only those two matching providers
