# Spec Delta

## ADDED Requirements

### Requirement: Function identity and arguments are separate contracts

The runtime SHALL validate the canonical Function identity independently from the named argument object, and SHALL use only the installed Function input Schema to construct an Action.

#### Scenario: Canonical Function with valid named arguments

- **WHEN** the model returns `ticket.create` and an object whose fields satisfy the installed input Schema
- **THEN** the runtime constructs the Action with those named arguments and does not remap them by position or natural-language labels

#### Scenario: Correct values assigned to the wrong fields

- **WHEN** the model returns valid-looking values under the wrong named fields
- **THEN** Schema and semantic validation reject the proposal or request clarification before execution

### Requirement: Model identity remains advisory

The runtime SHALL never treat a valid Function ID as execution authority; authorization, capability, policy, confirmation and idempotency checks SHALL remain mandatory after identity validation.

#### Scenario: Valid ID targets a high-risk action

- **WHEN** the model returns a valid `ticket.create` proposal for an operation requiring confirmation
- **THEN** the runtime stores a validated pending Action and does not invoke the Handler before confirmation
