# Runtime Contracts

## Purpose

为 IAR 宿主、插件和远程适配器提供稳定、可校验、可审计的公共契约，使插件能力在明确的 Function 边界内注册、启用和撤销。

## Requirements

### Requirement: Runtime contracts are versioned and schema-validated

IAR SHALL expose versioned contracts for Function、Plugin、Rule、Workflow、Action、Decision and related error results, and SHALL reject payloads that fail the declared schema before they enter runtime state.

#### Scenario: Invalid manifest is rejected

- **WHEN** an installation request omits `functionId`, declares an invalid schema, or uses an incompatible API version
- **THEN** installation is rejected with a stable validation error and no registry state is changed

### Requirement: Function plugins declare an auditable ownership boundary

Every function plugin manifest SHALL declare exactly one `functionId`, a fixed version, input and output schemas, capabilities, lifecycle entrypoint, policy metadata, and a bounded list of versioned fixed `actionTypes` used only for candidate narrowing inside the selected Plugin scope; a plugin SHALL NOT be eligible for routing outside its declared Function.

#### Scenario: Unknown action type is rejected

- **WHEN** a Function manifest declares an action type outside the Runtime action vocabulary
- **THEN** manifest validation rejects it before the Function can enter routing candidates

#### Scenario: Plugin is not routable outside its Function

- **WHEN** a decision requests a plugin whose manifest Function differs from the selected Function
- **THEN** the runtime excludes the plugin and records the ownership mismatch as an auditable reason

### Requirement: Plugin lifecycle changes are reversible

The runtime SHALL support discovered, validated, installed, enabled, disabled, draining, and unloaded states, and SHALL emit versioned lifecycle events for every successful or rejected transition.

#### Scenario: Unload removes current capability but preserves history

- **WHEN** an enabled plugin is unloaded while no policy allows new executions
- **THEN** current registry entries and subscriptions are removed, historical events remain queryable, and in-flight workflows follow the configured unavailable-plugin policy

### Requirement: System plugins are excluded from model routing

Runtime system plugins, including Persistence Providers and observability handlers, SHALL be loaded through explicit lifecycle or subscription registration and SHALL NOT appear in Function or Plugin decision candidates.

#### Scenario: Persistence Provider is not a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a persistence system plugin is absent from the candidate set and can only be invoked by the persistence bridge

#### Scenario: Logging system plugin does not become a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a `pluginKind=system` observability plugin is absent from the candidate set and can only run through its registered event subscription
