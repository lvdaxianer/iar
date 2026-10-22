# Runtime Contracts

## Purpose

为 IAR 宿主、插件和远程适配器提供稳定、可校验、可审计的公共契约，使插件能力在明确的 Function 边界内注册、启用和撤销。

## Requirements

### Requirement: Runtime contracts are versioned and schema-validated

IAR SHALL validate the new `iar.function-call/v1` proposal, its bounded tool descriptors and Function arguments before any unvalidated proposal reaches Action construction, authorization, confirmation or a Handler. Existing Plugin, Function input/output and `iar.decision/v1` contracts remain authoritative for legacy adapters.

#### Scenario: Malformed Function-call proposal fails closed

- **WHEN** a provider returns missing Plugin/Function identifiers, non-object arguments, an invalid confidence or unknown fields
- **THEN** the runtime returns a stable schema error and does not execute or expose the raw provider output

#### Scenario: Handler output is validated before reply generation

- **WHEN** a Function Handler returns a payload that does not satisfy its declared output Schema or the fixed response contract
- **THEN** the runtime records a stable execution failure and does not call the response model with that payload

#### Scenario: Invalid manifest is rejected

- **WHEN** an installation request omits Plugin identity, contains an invalid nested Function schema, or uses an incompatible API version
- **THEN** installation is rejected with a stable validation error and no registry state is changed

### Requirement: Function plugins declare an auditable ownership boundary

Every Function tool exposed to a model SHALL be derived from the installed Function definition and selected Plugin ownership. A model-provided tool schema, capability list or Plugin ID SHALL not replace the installed contract.

#### Scenario: Model cannot change input Schema

- **WHEN** a Function-call response includes a custom Schema, capability or operation not present in the installed Function record
- **THEN** the runtime ignores/rejects the extra data and validates against the installed record

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
