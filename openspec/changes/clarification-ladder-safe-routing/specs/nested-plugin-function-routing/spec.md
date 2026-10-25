# Spec Delta

## MODIFIED Requirements

### Requirement: One route call proposes the complete candidate

The primary route SHALL use at most one model call to propose the Plugin tool, nested Function/Operation and named JSON object arguments for the current message. The runtime SHALL distinguish a model-proposed Operation from an Operation explicitly supported by the current user input or an already verified same-session route. When the Function is identified but no unique Operation is supported, the runtime SHALL return a bounded Operation clarification containing only the registered Operations of that Function and SHALL NOT execute or enter confirmation using a default Operation.

#### Scenario: Query proposal is complete

- **WHEN** a user asks a query handled by an enabled Plugin
- **THEN** the route result contains the selected Plugin, Function, Operation and named arguments from one model call, with no duplicate operation field inside the arguments

#### Scenario: No matching candidate is proposed

- **WHEN** no enabled Plugin tool matches the current message
- **THEN** the runtime returns a bounded clarification or normal response without executing a Function

#### Scenario: Operation is missing from a matched proposal

- **WHEN** a model proposes a Plugin and Function but the current input does not establish a unique outer Operation
- **THEN** the runtime returns a stable operation-missing result, records the allowed operation IDs, asks the user to choose from that Function's bounded Operation catalog, and does not execute the Function

#### Scenario: Model default does not become an Operation

- **WHEN** the model proposes a read or action Operation that is not evidenced by the current message and no verified same-session Operation exists
- **THEN** the runtime treats the Operation as unresolved, does not use the Handler's default, and keeps the selected Plugin/Function identity for the next clarification turn

#### Scenario: Explicit Operation completes the same route

- **WHEN** the user supplies one allowed Operation after an operation clarification
- **THEN** the runtime retains the verified Plugin/Function, merges the named fields from the current and prior turns, and continues through Schema, policy and confirmation validation
