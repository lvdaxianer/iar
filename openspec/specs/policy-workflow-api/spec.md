# Policy Workflow API

## Purpose

在路由和插件选择之后统一控制权限、风险、确认与副作用执行，并向宿主提供可恢复、可查询、可继续输入的行为运行接口。

## Requirements

### Requirement: Policy Gate precedes every side effect

Before an action invokes a plugin, the runtime SHALL evaluate tenant, actor, capability, environment, risk, approval, confirmation, schema, timeout, and retry constraints, and SHALL fail closed for denied or missing high-risk authorization.

#### Scenario: Destructive action lacks confirmation

- **WHEN** a high-risk stop or delete action has valid routing but no confirmation matching its context hash
- **THEN** the runtime emits a confirmation requirement and does not invoke the plugin

### Requirement: Workflow execution is resumable and idempotent

The workflow runtime SHALL persist step transitions, pending inputs, attempts, external result summaries, timeout/cancellation state, and idempotency keys, and SHALL retry only errors declared retryable.

#### Scenario: Process restarts while waiting for confirmation

- **WHEN** a run is persisted in `await_confirmation` and the process restarts
- **THEN** querying or submitting confirmation resumes the same workflow and does not repeat subject resolution or a completed external action

### Requirement: Plugin execution has explicit outcome and error boundaries

Every action execution SHALL return a schema-validated accepted, succeeded, failed, denied, or unavailable outcome with stable error classification and correlation identifiers; raw model prompts and secrets SHALL not be exposed to the host response.

#### Scenario: Plugin timeout is exhausted

- **WHEN** a plugin exceeds its timeout and all permitted retries are consumed
- **THEN** the workflow records a classified failure, emits the corresponding event, and returns a host-safe error without silently retrying

### Requirement: Host API exposes the minimum run lifecycle

The host interface SHALL support creating a run, submitting subsequent input, submitting confirmation, reading current state and pending work, and installing/enabling/disabling plugins, with consistent trace, run, version, and error fields.

#### Scenario: Host submits follow-up confirmation

- **WHEN** the host posts a valid confirmation for an unexpired pending request
- **THEN** the runtime validates its scope and context hash, records the confirmation event, and advances the workflow according to policy
