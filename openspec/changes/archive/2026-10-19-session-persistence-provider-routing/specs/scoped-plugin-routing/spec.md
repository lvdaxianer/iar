# scoped-plugin-routing Specification

## Purpose

将 Plugin 业务范围、固定动作类型和 Function 选择组织成有限、可持续收敛的路由过程，避免按 `query` 或 `create` 在所有 Plugin 之间无界扩展候选。

## ADDED Requirements

### Requirement: Plugin scope precedes action filtering

The routing layer SHALL resolve an active Plugin scope from the current structured context or a finite Plugin summary catalog before expanding Function candidates. An `actionType` SHALL only filter Functions inside the active Plugin scope or an explicitly selected finite scope.

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugins each expose a `query` Function and the model selects one Plugin scope
- **THEN** the runtime loads only Functions from the selected Plugin scope and does not construct a global query candidate set

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Plugin and no active scope exists
- **THEN** the runtime asks a clarification question without loading executable Function candidates from every Plugin

### Requirement: Function manifests declare fixed action types

Every routable Function manifest SHALL declare a bounded list of fixed action types, and the runtime SHALL reject unknown or malformed action types before candidate construction.

#### Scenario: Action narrows a selected Plugin

- **WHEN** the selected Plugin contains `query`, `create`, and `update` Functions and the decision returns `query`
- **THEN** only the Plugin's query-compatible Functions are sent to the Function decision stage

### Requirement: Session routing scope is stateful

The structured session context SHALL preserve the active Plugin, bounded candidate Plugin IDs, continuation state, and pending route information. A follow-up SHALL reuse the active scope; a new or explicitly switched intent SHALL replace it; ambiguous short input SHALL retain the scope and request clarification.

#### Scenario: Short follow-up keeps the Plugin scope

- **WHEN** a session has active Plugin `human-service` and the user asks “我排第几位”
- **THEN** routing remains within `human-service` and does not rescan unrelated Plugin Functions

#### Scenario: Explicit domain switch replaces the scope

- **WHEN** the session is in `human-service` and the user asks to query an order
- **THEN** the routing scope changes to the order Plugin before Function candidates are expanded

### Requirement: Routing decisions remain non-authoritative

Plugin and action decisions SHALL remain finite model recommendations; final registry, authorization, policy, capability, confirmation, and enabled-state checks SHALL still run before execution. System Provider plugins SHALL not enter business routing candidates.

#### Scenario: Model cannot grant execution authority

- **WHEN** a model proposes a disabled, unauthorized, or policy-incompatible Function
- **THEN** the runtime rejects the proposal before execution and records the stable rejection reason
