# Spec Delta

## MODIFIED Requirements

### Requirement: Self-introduction is a routable built-in capability

The runtime SHALL provide a built-in self-introduction Plugin with one bounded Function that can be selected by the intent model and executed through the same routing and policy gates as other business capabilities. When the Plugin is enabled, identity and capability-introduction requests SHALL be eligible for this Function; when it is disabled, those requests SHALL not select it.

#### Scenario: Greeting selects self-introduction

- **WHEN** an enabled Agent receives an input such as `你是谁`, `介绍下自己` or `你能做什么`
- **THEN** the semantic decision can select the self-introduction Function and the runtime executes that Plugin without selecting an unrelated business Function

#### Scenario: Pure greeting remains ordinary conversation

- **WHEN** an enabled Agent receives a pure greeting such as `你好` without an identity or capability question
- **THEN** the semantic decision keeps the input on the ordinary unknown-input path instead of forcing self-introduction

#### Scenario: Disabled self-introduction is not selected

- **WHEN** an Agent is created with the self-introduction Plugin disabled and receives an identity or capability-introduction request
- **THEN** the request remains available to the normal unknown-input handling path and no self-introduction Function or Plugin is selected

#### Scenario: Self-introduction is not a privileged bypass

- **WHEN** the self-introduction Function is selected
- **THEN** it still passes current Agent availability, ownership, input validation and execution boundaries before its result is given to the response model

### Requirement: Capability inventory follows the current Agent scope

The self-introduction Plugin SHALL enumerate only business Plugins that are currently enabled and allowed in the Agent scope, SHALL exclude itself from the business inventory, and SHALL preserve each included Function's stable identifier and description.

#### Scenario: Disabled Plugin is absent

- **WHEN** an Agent is created with a business Plugin disabled
- **THEN** the self-introduction result excludes that Plugin and the disabled Function cannot be selected or executed in the same Agent

#### Scenario: New Plugin is included by default

- **WHEN** a new business Plugin is registered without an explicit disable rule
- **THEN** its bounded description is included in the next self-introduction inventory

### Requirement: Agent-level introduction prompt is structured data

The self-introduction Plugin SHALL accept an optional Agent-level supplementary prompt and return it as bounded structured data for the response model; the prompt SHALL influence presentation only and SHALL NOT add, remove or authorize a Plugin.

#### Scenario: Supplementary prompt reaches response generation

- **WHEN** an Agent is created with a self-introduction prompt requesting concise order-focused wording
- **THEN** the self-introduction result contains that prompt together with the current capability inventory for response generation

#### Scenario: Prompt cannot expand capabilities

- **WHEN** the supplementary prompt names a disabled or unregistered Plugin
- **THEN** the resulting inventory remains limited to the current Agent scope and does not make the named Plugin executable
