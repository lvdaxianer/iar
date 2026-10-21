# Spec Delta

## MODIFIED Requirements

### Requirement: Runtime provides an independent public entry

IAR SHALL provide a public `@iar/runtime` package entry that can initialize an intent and action runtime from installed Plugin packages and a decision provider. The entry SHALL default to installing the built-in self-introduction Plugin, SHALL accept an Agent-level disabled Plugin set and supplementary self-introduction prompt, and SHALL retain those validated values in the created Agent configuration.

#### Scenario: Application initializes the standalone runtime

- **WHEN** an application imports `@iar/runtime` from an installed package and supplies valid Plugin packages and a decision provider
- **THEN** the runtime initializes from the package's compiled public entry and exposes the current Plugin/Function routing capability

#### Scenario: Invalid Plugin package prevents partial initialization

- **WHEN** one supplied Plugin package fails contract validation or installation
- **THEN** initialization fails with a stable validation error and does not expose a partially installed runtime

#### Scenario: Agent creation defaults to built-in self-introduction

- **WHEN** an application creates an Agent without an explicit disable rule for self-introduction
- **THEN** the Agent includes the built-in self-introduction Function and its configuration is available to the session/runtime integration

#### Scenario: Agent creation filters explicitly disabled Plugins

- **WHEN** an application creates an Agent with a business Plugin ID in `disabledPluginIds`
- **THEN** that Plugin is not installed as an executable capability for the Agent, while all other supplied Plugins remain available

#### Scenario: New Plugins remain opt-out by default

- **WHEN** a supplied Plugin is not listed in `disabledPluginIds`
- **THEN** it is included in the Agent's default capability set without requiring an allow-list update

#### Scenario: Supplementary prompt is retained as Agent configuration

- **WHEN** an application creates an Agent with a bounded self-introduction supplementary prompt
- **THEN** the created Agent retains the prompt for self-introduction only and does not use it to change unrelated routing or execution policy
