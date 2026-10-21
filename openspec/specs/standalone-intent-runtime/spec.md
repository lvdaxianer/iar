# Standalone Intent Runtime

让 IAR 能作为一个不依赖特定宿主或基础设施的独立意图与动作运行时使用，
同时通过明确的扩展边界接入插件、持久化和外部宿主。

## Purpose

定义独立 IAR Runtime 的公共入口、宿主适配器隔离、Agent 级 Plugin 配置和可替换基础设施边界。

## Requirements

### Requirement: Runtime provides an independent public entry

IAR SHALL provide a public `@iar/runtime` package entry that can initialize an
intent and action runtime from installed Plugin packages and a decision provider.
The entry SHALL default to installing the built-in self-introduction Plugin,
shall accept an Agent-level disabled Plugin set including the built-in Plugin and
supplementary self-introduction prompt, and SHALL retain those validated values
in the created Agent configuration.

#### Scenario: Application initializes the standalone runtime

- **WHEN** an application imports `@iar/runtime` from an installed package and
  supplies valid Plugin packages and a decision provider
- **THEN** the runtime initializes from the package's compiled public entry and
  exposes the current Plugin/Function routing capability

#### Scenario: Invalid Plugin package prevents partial initialization

- **WHEN** one supplied Plugin package fails contract validation or installation
- **THEN** initialization fails with a stable validation error and does not expose
  a partially installed runtime

#### Scenario: Agent creation defaults to built-in self-introduction

- **WHEN** an application creates an Agent without an explicit disable rule for self-introduction
- **THEN** the Agent includes the built-in self-introduction Function and its configuration is available to the session/runtime integration

#### Scenario: Agent creation can disable built-in self-introduction

- **WHEN** an application creates an Agent with the built-in self-introduction Plugin ID in `disabledPluginIds`
- **THEN** the Agent excludes that Plugin from executable capabilities and routing/context descriptors while other supplied Plugins remain available

#### Scenario: Agent creation filters explicitly disabled Plugins

- **WHEN** an application creates an Agent with a business Plugin ID in `disabledPluginIds`
- **THEN** that Plugin is not installed as an executable capability for the Agent, while all other supplied Plugins remain available

#### Scenario: New Plugins remain opt-out by default

- **WHEN** a supplied Plugin is not listed in `disabledPluginIds`
- **THEN** it is included in the Agent's default capability set without requiring an allow-list update

#### Scenario: Supplementary prompt is retained as Agent configuration

- **WHEN** an application creates an Agent with a bounded self-introduction supplementary prompt
- **THEN** the created Agent retains the prompt for self-introduction only and does not use it to change unrelated routing or execution policy

### Requirement: Standalone runtime does not require a host adapter

The standalone `@iar/runtime` package SHALL run without Pi, HTTP, Fastify,
PostgreSQL, Temporal, or container-specific dependencies being configured.

#### Scenario: Runtime runs with in-process dependencies only

- **WHEN** an application initializes the runtime with in-process Plugins and a
  decision provider but no Pi or service adapter
- **THEN** it can perform intent decision and bounded Plugin/Function routing
  without loading a host adapter

#### Scenario: Host adapter is selected explicitly

- **WHEN** an application wants Pi, HTTP, or another host integration
- **THEN** it installs and configures the corresponding adapter explicitly, and
  the runtime core remains the owner of intent and routing state

### Requirement: Replaceable infrastructure remains outside the runtime core

Persistence, durable execution, transport, and host integration SHALL be
provided through explicit adapter boundaries and SHALL NOT change the runtime's
Plugin/Function ownership or decision semantics.

#### Scenario: Persistence provider is replaced

- **WHEN** an application selects the SQLite provider or a PostgreSQL provider
  through the persistence boundary
- **THEN** the runtime uses the selected provider without importing database
  implementation details into intent decision code

#### Scenario: Pi delegates to the runtime

- **WHEN** the Pi bridge receives an input and forwards it to IAR
- **THEN** `@iar/pi-bridge` transports the request and result while the runtime
  remains the only owner of routing, confirmation, and executable state
