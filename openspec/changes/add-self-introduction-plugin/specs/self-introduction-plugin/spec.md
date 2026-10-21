# Spec Delta

## Purpose

为每个 IAR Agent 提供一个可路由、可配置且基于当前可用 Plugin 自动汇总的自我介绍能力，让最终介绍由模型生成而不是由运行时维护另一套静态能力清单。

## ADDED Requirements

### Requirement: Self-introduction is a routable built-in capability

The runtime SHALL provide a built-in self-introduction Plugin with one bounded Function that can be selected by the intent model and executed through the same routing and policy gates as other business capabilities.

#### Scenario: Greeting selects self-introduction
- **WHEN** an enabled Agent receives an input such as `hi`, `你好`, `你是谁` or `你能做什么`
- **THEN** the semantic decision can select the self-introduction Function and the runtime executes that Plugin without selecting an unrelated business Function

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

### Requirement: Introduction output remains bounded and safe

The self-introduction result SHALL contain only bounded JSON-safe Plugin metadata and a bounded prompt, SHALL not include Handler references, credentials, raw model prompts or unrestricted execution output, and SHALL return a stable failure for malformed input.

#### Scenario: Malformed input fails closed
- **WHEN** the self-introduction Handler receives a non-object, oversized or unknown-field input
- **THEN** it returns the stable failed result without echoing the malformed value

#### Scenario: Handler data cannot grant authority
- **WHEN** the response model receives the self-introduction result
- **THEN** it can compose text from the inventory but cannot use that result to route or execute a Plugin that is absent from the current Agent scope
