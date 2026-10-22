# scoped-plugin-routing Specification

## Purpose

将 Plugin 业务范围、固定动作类型和 Function 选择组织成有限、可持续收敛的路由过程，避免按 `query` 或 `create` 在所有 Plugin 之间无界扩展候选。

## Requirements

### Requirement: Plugin scope precedes action filtering

The primary Agent routing path SHALL expose only bounded Plugin-level tools or descriptions, with each selected Plugin carrying its own current Function and Operation candidates as nested data. After runtime filtering and revalidation, the primary path SHALL NOT expose a cross-Plugin flattened Function list or require a separate Plugin-selection model call.

#### Scenario: First stage sees Plugin descriptions only

- **WHEN** an Agent has multiple enabled business Plugins with one or more Functions each
- **THEN** `semantic.extract` receives one bounded description per Plugin and does not receive Function input/output Schemas or a cross-Plugin Function candidate list

#### Scenario: Selected Plugin narrows Function candidates

- **WHEN** semantic extraction proposes an enabled authorized Plugin
- **THEN** the runtime revalidates that Plugin and provides only its current Functions to `function.call`

#### Scenario: Invalid Plugin proposal is non-authoritative

- **WHEN** the semantic model returns an unknown, disabled, unauthorized or action-incompatible Plugin ID
- **THEN** the runtime rejects or falls back to a bounded response path and does not load or execute a Function from that proposal

#### Scenario: Invalid nested proposal is non-authoritative

- **WHEN** the model returns an unknown, disabled, unauthorized or action-incompatible Plugin, Function or Operation
- **THEN** the runtime rejects or falls back to a bounded response path and does not load or execute the proposed registration

#### Scenario: Query does not load every Plugin query Function

- **WHEN** ten Plugin packages each expose a `query`-compatible Function and the current input has no active Function scope
- **THEN** the first semantic decision receives only bounded Plugin descriptions, and no Function implementation is loaded before Plugin validation succeeds

#### Scenario: Unknown domain is clarified

- **WHEN** the current input does not identify a Plugin and no active scope exists
- **THEN** the runtime asks a clarification question without selecting a Plugin or expanding executable candidates from unrelated packages

#### Scenario: Agent-disabled Plugin is excluded before routing

- **WHEN** an Agent creation configuration disables a Plugin that would otherwise match the current input
- **THEN** that Plugin and its Functions are absent from semantic/routing candidates, model context and self-introduction metadata and cannot be selected by a model

#### Scenario: Complete proposal is resolved by runtime

- **WHEN** the model proposes a Plugin tool, nested Function/Operation and named arguments
- **THEN** the runtime revalidates the Plugin and resolves only the matching installed Function registration

#### Scenario: Query does not create an unbounded flat candidate list

- **WHEN** ten Plugin packages each expose a query-compatible Function
- **THEN** the route request contains ten bounded Plugin tools with nested candidates, and no separately flattened cross-Plugin Function list

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

Plugin and action decisions SHALL remain finite model recommendations; final registry, authorization, policy, capability, confirmation, and enabled-state checks SHALL still run before execution. System Plugin packages SHALL not enter business routing candidates. Agent-level disabled Plugin configuration SHALL be enforced by the runtime registry and SHALL NOT be overridable by model output or self-introduction prompt text.

#### Scenario: Model cannot grant execution authority

- **WHEN** a model proposes a disabled, unauthorized, or policy-incompatible Function or Plugin
- **THEN** the runtime rejects the proposal before execution and records the stable rejection reason

#### Scenario: Prompt cannot re-enable a disabled Plugin

- **WHEN** self-introduction supplementary text requests that a disabled Plugin be included or used
- **THEN** the runtime keeps the Plugin unavailable and returns only the currently allowed capability inventory

#### Scenario: Disabled self-introduction is not a routing candidate

- **WHEN** the built-in self-introduction Plugin is included in the Agent disabled set
- **THEN** the semantic model, Function router and Plugin router receive no self-introduction candidate

### Requirement: Plugin packages own Function scope

The runtime SHALL derive every Function and Operation candidate from the selected Plugin package's validated nested registrations. Legacy Function-first decision adapters MAY remain available for compatibility but SHALL NOT widen the new Plugin-first path.

#### Scenario: Function routing uses package registrations

- **WHEN** a Plugin package exposes `knowledge.query` and `report.center`
- **THEN** both Function candidates are nested under that package's Plugin tool and Plugin selection for either candidate is restricted to the package's matching registration

#### Scenario: Multiple providers share a Function

- **WHEN** two enabled Plugin packages expose `ticket.query`
- **THEN** the Function stage retains one bounded Function identity and the Plugin stage receives only those two matching providers

### Requirement: The primary route uses bounded model stages

The primary nested route SHALL use at most one model proposal call and one response generation call when a model response is required. Legacy compatibility routes MAY use one semantic/Plugin proposal call, one Function-call proposal call, and one response generation call. Neither path SHALL call a separate Plugin-selection model after the proposal.

#### Scenario: Normal nested query has two model stages

- **WHEN** a user asks for a query handled by an enabled Plugin and the Function result uses `model` response mode
- **THEN** the runtime performs one nested Plugin/Function proposal and one `response.generate` call in that order

#### Scenario: Normal query has three model stages

- **WHEN** a user asks for a query handled by an enabled Plugin and the Function result uses `model` response mode
- **THEN** the runtime performs `semantic.extract`, `function.call`, and `response.generate` in that order

#### Scenario: Direct or none result skips response generation

- **WHEN** the selected Function returns a validated `direct` or `none` result for an allowed non-query operation
- **THEN** the runtime does not call `response.generate`

### Requirement: Agent-disabled Plugins are excluded before both stages

The Agent-level disabled Plugin set SHALL be applied before Plugin descriptions, semantic model context, Function tools, self-introduction metadata and fallback capability context are built.

#### Scenario: Disabled Plugin cannot be reintroduced

- **WHEN** a disabled Plugin is named by semantic extraction or Function Calling
- **THEN** the runtime rejects it using the current registry state and does not execute or describe it as available

### Requirement: Natural-language intent is not an ownership key

The runtime SHALL preserve natural-language intent for model context and user-facing explanation, but SHALL use registered Plugin/Function identifiers for Plugin ownership, Function membership and Operation resolution.

#### Scenario: Natural-language intent differs from Function ID

- **WHEN** semantic extraction returns “创建工单” and the nested route proposes `ticket.create`
- **THEN** the runtime resolves ownership and rules using the registered identifiers and does not reject the route solely because the two strings differ

#### Scenario: Disabled Plugin cannot be selected by a valid-looking ID

- **WHEN** a model returns a syntactically valid Function ID whose owning Plugin is disabled for the Agent
- **THEN** the runtime rejects the proposal before execution and does not reintroduce the Plugin through fallback context
