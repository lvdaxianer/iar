# Design

## Context

See `proposal.md` for the motivation and capability scope. The repository currently contains only the IAR architecture document and reference examples; there is no package manifest, runtime implementation, persistence layer, or test harness. The design therefore starts with a small language-agnostic contract surface and delays infrastructure that is not required by the MVP.

## Goals / Non-Goals

**Goals:**

- Keep `Function -> Plugin -> Policy -> Workflow -> Action` as the only executable path.
- Make contracts, state transitions, decisions, and side effects independently testable.
- Make Phase 1 and Phase 2 runnable without external model providers, PostgreSQL, MQ, containers, or Temporal.
- Preserve one contract across Embedded SDK, Sidecar, and Service adapters.
- Make every later phase an adapter or capability extension rather than a replacement of the runtime kernel.

**Non-Goals:**

- Implementing business plugins such as knowledge, ticket, or human-transfer in this planning change.
- Selecting a real LLM/JEV provider, defining provider-specific prompts, or storing credentials in the repository.
- Making Worker, container, PostgreSQL, MQ, vector search, or Temporal a Phase 1/2 dependency.
- Treating model output, a log observer, or a plugin manifest as an authorization grant.

## Decisions

### 1. Use a contract-first TypeScript workspace

The implementation plan uses a TypeScript + Node.js LTS workspace with JSON Schema, TypeBox, and Ajv-compatible runtime validation. `packages/contracts` owns versioned schemas, types, error codes, and event names; all other packages depend on contracts rather than each other’s internals.

Alternative considered: start directly inside a Fastify application. Rejected because it would make the HTTP adapter the de facto runtime boundary and would make Embedded SDK and Sidecar behavior diverge.

### 2. Keep the runtime kernel framework-independent

`packages/runtime` owns orchestration, context projection, route sequencing, policy gates, and workflow transitions. Fastify is an adapter under `packages/adapters`; plugins interact through `plugin-sdk` and `plugin-host`, not through Fastify internals.

Alternative considered: use NestJS or make Cordis a core dependency. Rejected because the design requires a small embeddable kernel and only borrows lifecycle ideas from plugin frameworks.

### 3. Enforce a two-stage bounded route

Semantic extraction produces a `SemanticFrame`. `rule-engine` creates finite Function candidates. The Function decision is validated before `rule-engine` creates Plugin candidates. Registry status, tenant, actor capabilities, environment, and policy remove ineligible candidates before the Plugin decision. Neither decision provider can execute actions or grant capabilities.

Alternative considered: expose all plugins to one model call. Rejected because it violates the Function boundary and makes authorization depend on open-ended model selection.

### 4. Use append-only events plus deterministic projections

`EventStore` is the recovery source of truth. `SnapshotStore` and `BehaviorContext` are projections with explicit schema versions and critical-field hashes. Replay tests compare projected state from the same event sequence. Compaction creates a candidate view and only becomes active after schema, event reference, workflow, confirmation, idempotency, and hash checks pass.

Alternative considered: persist only the latest conversation summary. Rejected because summaries cannot prove route ownership, confirmation scope, or the exact external action already attempted.

### 5. Keep Phase 1/2 storage and workflow local

Phase 1 plans an in-memory store plus SQLite adapter; Phase 2 uses a deterministic local workflow state machine. Both are behind `EventStore`, `SnapshotStore`, `RegistryStore`, and `WorkflowRuntime` interfaces. PostgreSQL and Temporal are later adapters, not replacements for the contracts.

Alternative considered: introduce PostgreSQL and Temporal at project bootstrap. Rejected because they add operational cost before the MVP proves event replay, idempotency, and route boundaries.

### 6. Treat hooks and state events as separate dispatch paths

Synchronous `before` hooks can return validated `allow`, `deny`, or `patch` outcomes and can block the action. State-event subscriptions are asynchronous by default and use explicit `failurePolicy`, timeout, retry, priority, correlation, and recursion limits. System logging is a fail-open observer and is not a routing candidate.

Alternative considered: make every subscription a blocking hook. Rejected because logging, metrics, and notifications must not make business side effects fail when observers are unavailable.

### 7. Isolate untrusted plugins through an executor adapter

Trusted plugins may run in-process in Phase 1. Phase 4 adds Worker/Sidecar/container executors with capability-scoped IPC or HTTP, resource limits, cancellation, cleanup, and version pinning. The runtime records the same action events regardless of executor type.

Alternative considered: treat a Worker as a complete security boundary by itself. Rejected; isolation must include credential scoping, resource limits, message validation, and lifecycle cleanup.

## Phase Architecture and Dependencies

```text
Phase 1 contracts/state
  -> Phase 2 route/policy/workflow
      -> Phase 3 model/API/examples
          -> Phase 4 service/isolation/observability
              -> Phase 5 durable/remote extensions
```

### Phase 1 — Contract and embedded foundation

Create the workspace and the following boundaries:

- `packages/contracts`: schemas, types, event names, error codes, version negotiation.
- `packages/plugin-sdk`: manifest builder, handler interfaces, schema validation helpers.
- `packages/plugin-host`: discovery, dependency ordering, registry, lifecycle transitions, reversible registration.
- `packages/storage`: EventStore, SnapshotStore, RegistryStore interfaces plus memory/SQLite adapters.
- `packages/subscriptions`: HookDefinition, StateEvent, Subscription Registry, Dispatcher.
- `packages/runtime`: run identity, BehaviorContext projection, replay, compaction validation seams.
- `tests/contract` and `tests/replay`: manifest, lifecycle, event replay, snapshot and critical-field invariants.

Exit condition: a fake plugin can be installed, enabled, observed through lifecycle events, unloaded reversibly, and recovered from an event sequence.

### Phase 2 — Bounded routing and local execution

Add:

- `packages/rule-engine`: FunctionRule/PluginRule, `ALL`/`ANY`/`NONE`, conflict and unknown-field policies.
- `packages/decision`: Mock DecisionProvider, validated choice/score/noul results, threshold handling.
- `packages/workflow`: local state machine, confirmation, retry classification, cancellation, resume, idempotency.
- Runtime orchestration from semantic frame to Function decision, Plugin decision, Policy Gate, workflow and action events.
- `tests/routing`, `tests/workflow`, and deterministic replay/idempotency cases.

Exit condition: the “list three services, stop the first service” scenario resolves `test1`, routes in two stages, waits for confirmation, and never executes without policy approval.

### Phase 3 — Model adapters, API and examples

Add:

- `packages/decision` provider adapters for Semantic Extractor and JEV behind `ModelGateway`.
- `config/models.yaml`, redaction, timeout/retry/fallback, immutable ModelProfile and decision audit fields.
- `packages/adapters/fastify` for `/v1/runs`, follow-up input, confirmation, state query, and plugin lifecycle APIs.
- `examples/knowledge-query`, `examples/ticket-create`, and `examples/human-transfer` as contract-tested plugins.

Exit condition: external model calls are schema-validated and audited, but provider failure falls back or produces a safe structured error without bypassing local routing/policy.

### Phase 4 — Service, isolation and observability

Add PostgreSQL and service adapters, Sidecar transport, CLI operations, OpenTelemetry/Pino integration, and isolated Worker/Sidecar/container executors. Add tenant-scoped registry/policy/event access, plugin version approval, resource limits, and redacted structured logging.

Exit condition: Embedded and Service modes share contract-shaped behavior; an untrusted plugin cannot retain active subscriptions after timeout or unload; audit fields and redaction are verified in integration tests.

### Phase 5 — Durable and remote extensions

Add a `WorkflowRuntime` adapter for Temporal only for long-running/timer/cross-service/compensation workflows. Add signed plugin metadata, remote distribution, capability-change approval, cross-language ABI, and multi-tenant control-plane operations only after Phase 4 evidence demonstrates the need.

Exit condition: a durable workflow resumes from its last persisted step after worker loss, preserves IAR policy/idempotency events, and remote plugin upgrades can be approved, rolled back, and audited.

## Data Flow and Error Boundaries

```text
Host input/event
  -> SemanticFrame (schema validation)
  -> FunctionRule candidates (evidence + exclusions)
  -> Function Decision (threshold/noul validation)
  -> PluginRule candidates (ownership/capability/tenant filters)
  -> Plugin Decision (schema + registry validation)
  -> Policy/Approval/Confirmation Gate
  -> WorkflowRuntime (persist before side effect)
  -> PluginExecutor (timeout/idempotency/cancellation)
  -> Action result (schema validation)
  -> EventLog + BehaviorContext projection + observer events
```

Each boundary returns stable typed errors. Validation, authorization, unavailable plugin, timeout, retry exhaustion, duplicate idempotency key, compaction rejection, and observer failure remain distinguishable. Observer failure follows subscription policy and cannot silently alter the main action result.

## Testing Strategy

- Contract tests validate every public JSON Schema, version, error code, Manifest and adapter payload.
- Rule tests cover `ALL`/`ANY`/`NONE`, priority/specificity conflicts, unknown fields, disabled plugins, and tenant/capability filtering.
- Replay tests rebuild BehaviorContext from event fixtures and compare critical-field hashes.
- Workflow tests cover confirmation, denial, retryable/non-retryable errors, cancellation, restart, and duplicate idempotency keys.
- Adapter tests run the same deterministic fixture through Embedded, Fastify, Sidecar, and Service boundaries as each adapter becomes available.
- Security tests assert redaction, fail-closed authorization, capability non-escalation, and untrusted executor cleanup.

## Risks / Trade-offs

- **[Risk]** A too-general contract slows early implementation → keep Phase 1 schemas minimal, versioned, and add fields only with compatibility tests.
- **[Risk]** Event projections drift from the state machine → require replay fixtures and critical-field hash checks in every projection change.
- **[Risk]** Model/provider failures look like routing failures → keep provider errors, decision rejection, and policy denial as separate error classes and events.
- **[Risk]** Local SQLite semantics differ from PostgreSQL → make adapters satisfy the same contract tests and document unsupported concurrency limits in Phase 1.
- **[Risk]** Isolation adds latency and operational complexity → keep trusted in-process execution for low-risk local plugins and require explicit policy for isolated executors.
- **[Risk]** Temporal or remote distribution becomes premature infrastructure → do not start Phase 5 until Phase 4 evidence identifies a concrete long-running or cross-service requirement.

## Migration Plan

1. Start from the current documentation-only repository and add project manifests, baseline files, and the Phase 1 workspace in one atomic task.
2. Keep all new contracts versioned under `iar.dev/v1` and keep adapters behind interfaces so later phases can be added without changing host-visible behavior.
3. Enable real model, database, service, and isolated executor adapters one at a time behind configuration and contract tests; Mock DecisionProvider remains the deterministic fallback.
4. For rollback, disable the newly enabled adapter or plugin version, replay the last valid event sequence, and resume using the previous fixed version; never delete historical events.

## Open Questions

- The concrete npm workspace tool (`pnpm` or npm workspaces) can be chosen before Phase 1 implementation without changing the public specs or package boundaries.
- The initial SQLite library and Fastify major version can be selected during Phase 1 dependency review, provided they satisfy the adapter and schema tests.
