# Spec Delta

## MODIFIED Requirements

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

#### Scenario: Unknown action type is rejected

- **WHEN** a Function registration declares an action type outside the Runtime action vocabulary
- **THEN** manifest validation rejects it before the Function can enter routing candidates

#### Scenario: Plugin is not routable outside its Function

- **WHEN** a decision requests a Plugin implementation for a Function that is not contained in that package
- **THEN** the runtime excludes the implementation and records the ownership mismatch as an auditable reason

#### Scenario: Model cannot change input Schema

- **WHEN** a Function-call response includes a custom Schema, capability or operation not present in the installed Function record
- **THEN** the runtime ignores/rejects the extra data and validates against the installed record
