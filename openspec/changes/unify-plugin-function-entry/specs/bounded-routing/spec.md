# Spec Delta

## MODIFIED Requirements

### Requirement: Function routing precedes Plugin routing

The runtime SHALL evaluate Function rules and select or reject a Function before evaluating Plugin rules; Plugin rules SHALL only inspect enabled, authorized Plugin implementations whose Function registration belongs to the selected Function and whose metadata came from a validated Plugin package.

#### Scenario: Mixed business intents are routed in two stages

- **WHEN** semantic input can represent knowledge query, ticket creation, or human transfer
- **THEN** the first decision receives only rule-produced Function candidates from registered packages, and the second decision receives only candidates belonging to the selected Function

### Requirement: Decisions are constrained and typed

Function and Plugin decision providers SHALL receive finite candidates and structured constraints derived from validated Plugin packages, and SHALL return a validated choice, rejection, or `needs_clarification` result with score, threshold, reason, and decision version. JEV and the Intent Model backend SHALL both return the same `iar.decision/v1` result shape. When both backends are configured for the same decision stage, the runtime SHALL select JEV; when JEV is absent, the runtime SHALL select the Intent Model backend.


#### Scenario: JEV is preferred when both backends are configured

- **WHEN** a Function or Plugin decision stage has valid JEV and Intent Model profiles and its finite candidates came from validated Plugin packages
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
- **THEN** the runtime returns `needs_clarification`, does not select a Plugin, and does not start a side-effecting workflow

### Requirement: Decision output cannot grant authority

A model decision SHALL NOT add capabilities, alter input schemas, change Function ownership, bypass disabled-Plugin filtering, or authorize an action; the runtime SHALL revalidate the selected result against the current Plugin package, tenant, actor, environment, and policy constraints.

#### Scenario: Model requests an unauthorized plugin

- **WHEN** a Plugin decision names a disabled or unauthorized implementation from a registered package
- **THEN** the runtime rejects the decision, records the candidate and rejection reason, and leaves the workflow outside execution

## ADDED Requirements

### Requirement: Package metadata cannot expand finite decisions

Plugin package metadata SHALL be projected into a decision request only after the current finite Function or Plugin candidate boundary has been established.

#### Scenario: Unrequested package Function is not selectable

- **WHEN** a Plugin package contains a Function not present in the current decision candidate list
- **THEN** the decision adapter cannot add that Function or its Plugin provider to the request's candidate IDs
