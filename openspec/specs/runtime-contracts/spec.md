# Runtime Contracts

## Purpose

为 IAR 宿主、插件和远程适配器提供稳定、可校验、可审计的公共契约，使插件能力在明确的 Function 边界内注册、启用和撤销。

## Requirements

### Requirement: Runtime contracts are versioned and schema-validated

IAR SHALL expose versioned contracts for Plugin packages, nested Function registrations, Rule, Workflow, Action, Decision and related error results, and SHALL reject payloads that fail the declared schema before any Plugin, Function or Handler enters runtime state.

#### Scenario: Invalid manifest is rejected

- **WHEN** an installation request omits Plugin identity, contains an invalid nested Function schema, or uses an incompatible API version
- **THEN** installation is rejected with a stable validation error and no registry state is changed

### Requirement: Function plugins declare an auditable ownership boundary

Every business Plugin package SHALL declare Plugin-level metadata and a bounded list of Function definitions; every Function definition SHALL declare its own `functionId`, fixed version, input and output schemas, capabilities, risk level, operations, and fixed action types. A Function SHALL be routable only through a Plugin package that contains that exact registration.

#### Scenario: Unknown action type is rejected

- **WHEN** a Function registration declares an action type outside the Runtime action vocabulary
- **THEN** manifest validation rejects it before the Function can enter routing candidates

#### Scenario: Plugin is not routable outside its Function

- **WHEN** a decision requests a Plugin implementation for a Function that is not contained in that package
- **THEN** the runtime excludes the implementation and records the ownership mismatch as an auditable reason

### Requirement: Plugin lifecycle changes are reversible

The runtime SHALL support discovered, validated, installed, enabled, disabled, draining, and unloaded states for Plugin packages, and SHALL emit versioned lifecycle events for every successful or rejected transition; package lifecycle changes SHALL apply atomically to all nested Function registrations.

#### Scenario: Unload removes current capability but preserves history

- **WHEN** an enabled Plugin package is unloaded while no policy allows new executions
- **THEN** all current Function indexes and subscriptions owned by that package are removed, historical events remain queryable, and in-flight workflows follow the configured unavailable-Plugin policy

### Requirement: System plugins are excluded from model routing

Runtime system Plugin packages, including Persistence Providers and observability handlers, SHALL be loaded through explicit lifecycle or subscription registration and SHALL NOT appear in Function or Plugin decision candidates.

#### Scenario: Persistence Provider is not a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a persistence system plugin is absent from the candidate set and can only be invoked by the persistence bridge

#### Scenario: Logging system plugin does not become a business candidate

- **WHEN** the runtime builds candidates for a business Function
- **THEN** a system observability Plugin is absent from the candidate set and can only run through its registered event subscription

### Requirement: A Plugin package can own multiple Function definitions

Every business Plugin package SHALL expose an auditable, bounded set of Function definitions, and each Function SHALL retain its own input/output schemas, capabilities, risk level, fixed action types and operations.

#### Scenario: One package owns multiple Functions

- **WHEN** a Plugin package declares `ticket.query` and `ticket.create`
- **THEN** both Function ownership relationships are auditable through the same Plugin ID, while their schemas and handlers remain independently addressable

#### Scenario: Package ownership mismatch is rejected

- **WHEN** a Plugin decision names a Function that is not contained in the selected package
- **THEN** the runtime rejects the candidate before execution and leaves registry state unchanged

### Requirement: Package lifecycle applies atomically to nested Functions

Plugin lifecycle transitions SHALL update all nested Function indexes as one state change.

#### Scenario: Failed package transition keeps all Functions unavailable

- **WHEN** enabling or installing a Plugin package fails after validation
- **THEN** none of the package's Function registrations appear as enabled candidates
