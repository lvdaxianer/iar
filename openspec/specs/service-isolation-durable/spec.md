# Service Isolation Durable

## Purpose

在嵌入式 MVP 之外提供可独立升级、可隔离执行、可观测和可扩展的部署边界，并在长时间运行或跨服务补偿确有需要时接入持久化工作流运行时。

## Requirements

### Requirement: Deployment modes preserve one runtime contract

Embedded SDK、Sidecar 和 Service 模式 SHALL expose the same versioned runtime contracts and SHALL preserve trace, tenant, authorization, policy, event, and workflow semantics across transport boundaries.

#### Scenario: Sidecar receives the same run request

- **WHEN** a host sends a schema-valid run request through the Sidecar transport
- **THEN** the runtime produces the same contract-shaped state and errors as the embedded adapter for the same deterministic inputs

### Requirement: Untrusted plugins execute outside the host process

The runtime SHALL provide an isolation boundary for plugins that are not explicitly trusted in-process, including resource limits, timeout, cancellation, capability-scoped communication, and lifecycle cleanup.

#### Scenario: Isolated plugin exceeds its resource limit

- **WHEN** an untrusted plugin exceeds its configured timeout or resource budget
- **THEN** the executor terminates or quarantines the plugin according to policy, records the failure, and prevents the plugin from retaining active subscriptions

### Requirement: Service operations are tenant- and version-isolated

Service mode SHALL isolate registry, policy, event visibility, credentials, and plugin versions by tenant and SHALL require explicit authorization for installation, upgrade, enablement, disablement, and capability expansion.

#### Scenario: Tenant cannot select another tenant's plugin

- **WHEN** a decision or API request references a plugin registered for another tenant
- **THEN** the request is rejected before candidate construction or execution and the rejection is auditable

### Requirement: Long-running workflows use an explicit durable adapter

The runtime SHALL keep short actions on the local deterministic state machine and SHALL use a durable workflow adapter only for configured long-running, cross-service, timer, or compensation requirements; adapter execution SHALL preserve IAR workflow and policy events.

#### Scenario: Durable adapter resumes after worker loss

- **WHEN** a configured long-running workflow worker is lost after a persisted step
- **THEN** the adapter resumes from the last durable step with the same workflow identity and idempotency constraints, without bypassing Policy Gate

### Requirement: Observability is structured and redacted

All deployment modes SHALL emit correlated structured logs, traces, metrics, and audit events with route, policy, confirmation, plugin version, and error classification fields while redacting raw prompts, raw user input, API keys, authorization values, and configured sensitive slots by default.

#### Scenario: Log destination is unavailable

- **WHEN** the structured log destination fails for a non-blocking observer subscription
- **THEN** the business action continues according to fail-open policy and the observability failure is counted and correlated
