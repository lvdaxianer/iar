# Bounded Routing

## Purpose

把开放式语义理解约束为“先选 Function、再选 Plugin”的有限决策过程，让规则负责候选边界，让类型化决策负责选择、拒绝或澄清。

## Requirements

### Requirement: Function routing precedes Plugin routing

The runtime SHALL evaluate Function rules and select or reject a Function before evaluating Plugin rules; Plugin rules SHALL only inspect enabled, authorized plugins belonging to the selected Function.

#### Scenario: Mixed business intents are routed in two stages

- **WHEN** semantic input can represent knowledge query, ticket creation, or human transfer
- **THEN** the first decision receives only rule-produced Function candidates, and the second decision receives only candidates belonging to the selected Function

### Requirement: Composite rules produce explainable candidates

The rule engine SHALL support `ALL`, `ANY`, and `NONE`, record matched rules, excluded candidates, rule versions, required slots, risk labels, and evidence codes, and SHALL treat unknown fields according to the configured unknown-field policy.

#### Scenario: Exclusion prevents a completed workflow from being rerouted

- **WHEN** a `NONE` condition excludes a Function because the current workflow is completed
- **THEN** that Function is absent from the candidate set and the exclusion reason is included in the decision evidence

### Requirement: Decisions are constrained and typed

Function and Plugin decision providers SHALL receive finite candidates and structured constraints, and SHALL return a validated choice, rejection, or `needs_clarification` result with score, threshold, reason, and decision version.

#### Scenario: Low-confidence choice requires clarification

- **WHEN** the best candidate score is below its configured threshold or two candidates remain indistinguishable
- **THEN** the runtime returns `needs_clarification`, does not select a plugin, and does not start a side-effecting workflow

### Requirement: Decision output cannot grant authority

A model decision SHALL NOT add capabilities, alter input schemas, change Function ownership, bypass disabled-plugin filtering, or authorize an action; the runtime SHALL revalidate the selected result against registry, tenant, actor, environment, and policy constraints.

#### Scenario: Model requests an unauthorized plugin

- **WHEN** a Plugin decision names a disabled or unauthorized plugin
- **THEN** the runtime rejects the decision, records the candidate and rejection reason, and leaves the workflow outside execution
