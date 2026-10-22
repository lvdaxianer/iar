# Spec Delta

## ADDED Requirements

### Requirement: Semantic completeness gates bounded routing

The runtime SHALL distinguish an incomplete semantic frame from an empty candidate set and SHALL prevent Function or Plugin decision providers from being invoked when required routing fields are missing.

#### Scenario: Missing semantic field stops the route
- **WHEN** the extracted frame lacks a required action, intent, or canonical route identity
- **THEN** the runtime returns a stable incomplete-frame reason and does not invoke route proposal, Plugin selection, or execution

#### Scenario: Empty candidates remain a distinct route result
- **WHEN** the semantic frame is complete but no enabled and authorized candidate satisfies it
- **THEN** the runtime returns a no-candidate reason distinct from incomplete extraction and does not execute a Function

### Requirement: Recovery preserves the existing authority boundary

The runtime SHALL accept recovered fields only after they are validated against the current finite session state, registered Plugin/Function contracts, authorization, policy and confirmation rules.

#### Scenario: User supplies the missing field
- **WHEN** a user answers a runtime-generated clarification with a value that maps to one finite allowed field
- **THEN** the runtime re-runs the normal route and policy gates before any execution

#### Scenario: User supplies an unknown field value
- **WHEN** a clarification answer does not map to the finite allowed values
- **THEN** the runtime keeps the action unexecuted and returns another bounded clarification or unavailable result
