# Spec Delta

## ADDED Requirements

### Requirement: Natural-language intent is not an ownership key

The runtime SHALL preserve natural-language intent for model context and user-facing explanation, but SHALL use registered Plugin/Function identifiers for Plugin ownership, Function membership and Operation resolution.

#### Scenario: Natural-language intent differs from Function ID

- **WHEN** semantic extraction returns “创建工单” and the nested route proposes `ticket.create`
- **THEN** the runtime resolves ownership and rules using the registered identifiers and does not reject the route solely because the two strings differ

#### Scenario: Disabled Plugin cannot be selected by a valid-looking ID

- **WHEN** a model returns a syntactically valid Function ID whose owning Plugin is disabled for the Agent
- **THEN** the runtime rejects the proposal before execution and does not reintroduce the Plugin through fallback context
