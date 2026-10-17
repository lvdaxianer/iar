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

Function and Plugin decision providers SHALL receive finite candidates and structured constraints, and SHALL return a validated choice, rejection, or `needs_clarification` result with score, threshold, reason, and decision version. JEV and the Intent Model backend SHALL both return the same `iar.decision/v1` result shape. When both backends are configured for the same decision stage, the runtime SHALL select JEV; when JEV is absent, the runtime SHALL select the Intent Model backend.

#### Scenario: JEV is preferred when both backends are configured

- **WHEN** a Function or Plugin decision stage has valid JEV and Intent Model profiles
- **THEN** the runtime invokes JEV, records the selected backend in model audit metadata, and does not invoke the Intent Model for that decision

#### Scenario: Intent Model is used when JEV is absent

- **WHEN** a decision stage has a valid Intent Model profile but no JEV profile
- **THEN** the runtime invokes the Intent Model through the same gateway boundary and exposes the same `DecisionResult` to routing

#### Scenario: Intent Model output stays inside the existing decision boundary

- **WHEN** the Intent Model returns an unknown candidate, a changed candidate list, an incompatible decision type/version, an invalid score, or non-JSON output
- **THEN** the runtime rejects the result with the existing stable decision error and does not select a Function, Plugin, or side effect

#### Scenario: Low-confidence choice remains a clarification

- **WHEN** the Intent Model returns a valid choice whose score is below the configured threshold
- **THEN** the shared validator converts it to `needs_clarification` without preserving an executable choice

#### Scenario: Low-confidence choice requires clarification

- **WHEN** the best candidate score is below its configured threshold or two candidates remain indistinguishable
- **THEN** the runtime returns `needs_clarification`, does not select a plugin, and does not start a side-effecting workflow

### Requirement: Intent Model prompts are versioned and non-authoritative

The Intent Model adapter SHALL use a versioned prompt that requires JSON-only `iar.decision/v1` output, exact copying of `decisionType`, `decisionVersion`, and ordered `candidateIds`, and SHALL explicitly forbid adding candidates, granting capabilities, authorizing actions, or executing plugins. The prompt output SHALL remain advisory until the existing rule, registry, tenant, actor, environment, policy, and capability checks complete.

#### Scenario: Prompt contract produces a JEV-compatible response

- **WHEN** the adapter sends a decision request to the Intent Model
- **THEN** the request contains the fixed prompt version and the model is required to return only the shared `DecisionResult` fields

#### Scenario: Valid Intent Model choice passes shared validation only

- **WHEN** the Intent Model returns a candidate from the finite set with a score at or above threshold
- **THEN** the adapter returns the same normalized `DecisionResult` type used by JEV, while the runtime still performs final authority revalidation

### Requirement: Decision output cannot grant authority

A model decision SHALL NOT add capabilities, alter input schemas, change Function ownership, bypass disabled-plugin filtering, or authorize an action; the runtime SHALL revalidate the selected result against registry, tenant, actor, environment, and policy constraints.

#### Scenario: Model requests an unauthorized plugin

- **WHEN** a Plugin decision names a disabled or unauthorized plugin
- **THEN** the runtime rejects the decision, records the candidate and rejection reason, and leaves the workflow outside execution
