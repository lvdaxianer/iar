# Spec Delta

## ADDED Requirements

### Requirement: Pass-through carries the current capability context

When IAR returns `pass_through`, the Bridge response SHALL optionally carry a bounded catalog of the current Agent's enabled and authorized Function/Plugin descriptions for the downstream Pi Host model. The catalog SHALL be context data only and SHALL not authorize an IAR action.

#### Scenario: Pi Host receives enabled capability context

- **WHEN** IAR does not match a Function and returns `pass_through`
- **THEN** the Bridge response contains the current enabled capability descriptions and the Pi Host can include them in the next model input

#### Scenario: Disabled capability is not exposed

- **WHEN** a Plugin is disabled in the Agent configuration before a pass-through request
- **THEN** its Function and Plugin descriptions are absent from the Bridge context

#### Scenario: Legacy response remains valid

- **WHEN** a Pi client receives a pass-through response without the optional capability context
- **THEN** it continues the existing Pi handling path without treating the missing field as an error

#### Scenario: Capability context cannot execute actions

- **WHEN** the downstream Pi model receives the pass-through capability context
- **THEN** it may use the descriptions to answer the user but IAR still requires a new bridge request and normal routing/policy gates for any business execution
