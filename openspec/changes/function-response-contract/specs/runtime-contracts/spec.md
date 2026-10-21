# Spec Delta

## MODIFIED Requirements

### Requirement: Runtime contracts are versioned and schema-validated

IAR SHALL expose versioned contracts for Plugin packages, nested Function registrations, Function input/output and response results, Rule, Workflow, Action, Decision and related error results, and SHALL reject payloads that fail the declared schema before any Plugin, Function or Handler enters runtime state or any unvalidated Handler result reaches a user or model.

#### Scenario: Handler output is validated before reply generation

- **WHEN** a Function Handler returns a payload that does not satisfy its declared output Schema or the fixed response contract
- **THEN** the runtime records a stable execution failure and does not call the response model with that payload

#### Scenario: Invalid manifest is rejected

- **WHEN** an installation request omits Plugin identity, contains an invalid nested Function schema, or uses an incompatible API version
- **THEN** installation is rejected with a stable validation error and no registry state is changed
