# IAR Five-Phase Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 IAR 方案从文档落地为可测试的 TypeScript/Node.js 运行时，按 Phase 1～5 逐步交付契约、路由、策略、API、服务化和持久工作流能力。

**Architecture:** 以 framework-independent runtime kernel 为核心，使用 `Function → Plugin → Policy → Workflow → Executor` 固定链路；EventLog 是事实源，BehaviorContext 是可重放投影，Fastify、PostgreSQL、Sidecar、隔离执行器和 durable workflow 都通过适配器接入。Phase 1/2 使用本地确定性实现，Phase 3～5 只在前一阶段的契约和测试证据满足后扩展。

**Tech Stack:** TypeScript、Node.js LTS、npm workspaces、JSON Schema、TypeBox/Ajv-compatible validation、Fastify adapter、SQLite/本地 EventStore、PostgreSQL adapter、OpenTelemetry、Pino、可选 Temporal adapter、Vitest-style contract/replay/integration tests。

---

## 执行规则

- 所有任务从 `master` 集成分支派生独立 task branch/worktree，并在完成后合并回 `master`。
- 每个任务先定义允许文件和排除范围，再按 RED → GREEN → broader verification 执行；生产代码不得先于失败测试写入。
- 每个任务完成前都要运行 plan-implementation consistency audit、适用领域审查和 per-task audit。
- Phase 1～5 的具体需求、非目标和状态不变量以 `openspec/changes/iar-five-phase-roadmap/` 为准。

## Task 1: Phase 1 契约与嵌入式基础

**Files:**

- Create: `package.json`、`tsconfig.json`、workspace package manifests、`packages/contracts/**`、`packages/plugin-sdk/**`、`packages/plugin-host/**`、`packages/storage/**`、`packages/subscriptions/**`、`packages/runtime/**`
- Create: `tests/contract/**`、`tests/replay/**`、`docs/contracts/**`
- Modify: `docs/README.md` only when examples need to match the final contract names

**Boundary:** 只负责公共契约、Manifest 生命周期、EventLog/Snapshot/BehaviorContext、Hook/Event 订阅和重放；不接入真实模型、HTTP、PostgreSQL、Worker、容器或 Temporal。

- [ ] **Step 1: 建立工作区与失败基线测试**

  Add the workspace scripts `build`, `lint`, and `test`, then add a contract test that imports the not-yet-existing public contract entrypoint and expects the `iar.dev/v1` schema registry to expose the required names.

  Run: `npm test -- --run tests/contract/contracts.test.ts`

  Expected: RED because the contracts package and schema registry do not exist.

- [ ] **Step 2: 实现最小契约和 Schema 校验**

  Define versioned types and runtime validators for `PluginManifest`, `Action`, `Decision`, `BehaviorContext`, event envelopes, and stable error codes under `packages/contracts/`. Keep the validator boundary independent of storage and HTTP.

  Run: `npm test -- --run tests/contract/contracts.test.ts`

  Expected: GREEN for valid fixtures and rejection for missing fields, invalid ownership, and incompatible versions.

- [ ] **Step 3: 添加插件 Host、Store 和订阅边界**

  Implement Manifest registration/lifecycle, EventStore/SnapshotStore/RegistryStore interfaces, in-memory adapter, and Hook/StateEvent subscription records. Add tests for reversible unload, priority ordering, idempotent subscription delivery, and fail-open/fail-closed behavior.

  Run: `npm test -- --run tests/contract tests/replay`

  Expected: GREEN with lifecycle events and subscription evidence.

- [ ] **Step 4: 实现 BehaviorContext projection、replay 和 compaction guard**

  Implement the projection and critical-field hash checks under `packages/runtime/`; add fixtures that preserve subject provenance, route, slots, workflow step, pending confirmation, and idempotency key.

  Run: `npm test -- --run tests/replay`

  Expected: replay is deterministic; a compactor result that changes a critical field is rejected and leaves the previous view active.

- [ ] **Step 5: Run Phase 1 broader verification and commit**

  Run: `npm run lint && npm run build && npm test`

  Expected: all checks pass, no build artifacts or secrets are staged, and the task branch contains only Phase 1 files plus its OpenSpec planning assets.

## Task 2: Phase 2 受限路由与本地执行

**Files:**

- Create: `packages/rule-engine/**`、`packages/decision/**`、`packages/workflow/**`
- Modify: `packages/runtime/**` to add two-stage orchestration and Policy Gate integration
- Create: `tests/routing/**`、`tests/workflow/**`、`tests/replay/stop-first-service.fixture.*`

**Boundary:** 只实现本地规则、Mock Decision、策略、确认、Workflow、幂等和恢复；不调用真实 Provider 或外部数据库。

- [ ] **Step 1: Write RED tests for bounded candidates**

  Add rule fixtures for `ALL`/`ANY`/`NONE`, Function/Plugin ownership, disabled plugins, unknown fields, conflict resolution, threshold rejection, and `needs_clarification`.

  Run: `npm test -- --run tests/routing`

  Expected: RED because rule evaluation and typed decision provider are not implemented.

- [ ] **Step 2: Implement FunctionRule/PluginRule and Mock Decision**

  Generate finite candidates with matched/excluded evidence, then validate choice/score/rejection/noul output against the candidate set and thresholds.

  Run: `npm test -- --run tests/routing`

  Expected: GREEN; a model-like result cannot add a capability or bypass a disabled plugin.

- [ ] **Step 3: Implement Policy Gate and local Workflow**

  Add policy checks, confirmation scope/hash, retry classification, timeout/cancel/resume, action persistence-before-side-effect, and idempotency lookup under `packages/workflow/`.

  Run: `npm test -- --run tests/workflow`

  Expected: GREEN; high-risk actions stop before executor without matching confirmation.

- [ ] **Step 4: Implement the `test1` acceptance replay**

  Connect SemanticFrame → Function decision → Plugin decision → Policy → confirmation → Action result and add the “列出三个 DIP 服务后停止第一个服务” fixture.

  Run: `npm test -- --run tests/routing tests/workflow tests/replay/stop-first-service.fixture.test.ts`

  Expected: `subject.id=test1`, `functionId=dip.service.stop`, authorized plugin only, and one external invocation after confirmation.

- [ ] **Step 5: Run Phase 2 broader verification and commit**

  Run: `npm run lint && npm run build && npm test`

  Expected: all route, workflow, replay, and idempotency checks pass.

## Task 3: Phase 3 模型适配、API 与示例插件

**Files:**

- Create: `config/models.yaml`、`packages/decision/model-gateway/**`、`packages/adapters/fastify/**`
- Create: `examples/knowledge-query/**`、`examples/ticket-create/**`、`examples/human-transfer/**`
- Create: `tests/integration/model-gateway/**`、`tests/integration/fastify/**`、`tests/contract/examples/**`
- Modify: `.env.example` only when a new non-secret model variable is introduced by the implementation

**Boundary:** 只把模型和 API 接到既有 runtime contract；不修改两阶段路由、Policy 或 Workflow 语义。

- [ ] **Step 1: Write RED tests for ModelGateway boundaries**

  Add Mock Provider tests for role selection, structured output validation, timeout/retry/fallback, request redaction, and profile/model version audit fields.

  Run: `npm test -- --run tests/integration/model-gateway`

  Expected: RED because provider adapters and profile loader do not exist.

- [ ] **Step 2: Implement ModelGateway and Semantic/JEV adapters**

  Add `semanticExtractor`, `functionDecision`, `pluginDecision`, `contextCompactor`, and `responseGenerator` roles with schema validation and safe error mapping. Keep API keys outside manifests and source files.

  Run: `npm test -- --run tests/integration/model-gateway`

  Expected: GREEN; Provider failure cannot bypass local candidate, policy, or confirmation gates.

- [ ] **Step 3: Implement Fastify host APIs**

  Add `POST /v1/runs`, follow-up input, confirmation, state query, plugin install/enable/disable routes and contract-shaped responses with trace/run/version/error fields.

  Run: `npm test -- --run tests/integration/fastify`

  Expected: GREEN; raw prompts, API keys, authorization headers, and raw user input are absent from host responses.

- [ ] **Step 4: Implement and contract-test three examples**

  Add manifests and handlers for knowledge query, ticket creation, and human transfer; verify Function ownership, input/output Schema, capabilities, risk and confirmation policy.

  Run: `npm test -- --run tests/contract/examples tests/integration/fastify`

  Expected: every example is installable and can run through the same bounded route.

- [ ] **Step 5: Run Phase 3 broader verification and commit**

  Run: `npm run lint && npm run build && npm test`

  Expected: model, API, example, route, workflow, and replay suites pass together.

## Task 4: Phase 4 服务化、隔离执行与观测

**Files:**

- Create: `packages/adapters/postgres/**`、`packages/adapters/service/**`、`packages/adapters/sidecar/**`、`packages/adapters/executors/**`
- Create: `packages/cli/**`、`packages/observability/**`、`packages/built-in-plugins/**`
- Create: `tests/security/**`、`tests/integration/service/**`、`tests/integration/executor/**`

**Boundary:** 只新增 Service/Sidecar/CLI、PostgreSQL、隔离执行和观测适配；不引入 Temporal 或远程 ABI。

- [ ] **Step 1: Write RED tests for adapter parity and tenant isolation**

  Add the same deterministic fixture for Embedded, Sidecar, and Service boundaries, plus cross-tenant registry/event/policy access tests.

  Run: `npm test -- --run tests/integration/service tests/security/tenant-isolation.test.ts`

  Expected: RED because service adapters and tenant scopes do not exist.

- [ ] **Step 2: Implement PostgreSQL, Service, Sidecar and CLI adapters**

  Implement the existing Store and runtime contracts over PostgreSQL and transport boundaries; add `install`, `enable`, `disable`, `inspect`, and `replay` CLI commands without changing core semantics.

  Run: `npm test -- --run tests/integration/service`

  Expected: GREEN; adapter parity holds and tenant boundaries reject foreign plugin references.

- [ ] **Step 3: Implement isolated executors and cleanup**

  Add capability-scoped messages, timeout/cancel/resource limits, credential isolation, version pinning, and subscription cleanup for Worker/Sidecar/container execution.

  Run: `npm test -- --run tests/integration/executor`

  Expected: GREEN; an untrusted plugin cannot retain active subscriptions after timeout or unload.

- [ ] **Step 4: Implement structured observability and redaction**

  Add trace/metric/log/audit fields and the system logging plugin with fail-open observer handling. Add snapshot assertions for API key, authorization, raw prompt, raw input, and configured sensitive slots.

  Run: `npm test -- --run tests/security tests/integration/service`

  Expected: GREEN; logs remain correlated and redacted while observer failure does not block business action.

- [ ] **Step 5: Run Phase 4 broader verification and commit**

  Run: `npm run lint && npm run build && npm test` plus disposable PostgreSQL/service/executor integration commands documented in the task output.

  Expected: all adapter, security, observability, and existing runtime suites pass.

## Task 5: Phase 5 持久工作流与远程扩展

**Files:**

- Create: `packages/adapters/temporal/**`、`packages/plugin-distribution/**`、`packages/abi/**`、`packages/control-plane/**`
- Create: `tests/durable/**`、`tests/distribution/**`、`tests/compatibility/**`

**Boundary:** 只有 Phase 4 已证明存在长时间运行/跨服务/补偿需求时才启用；不得替换本地短动作路径或绕过 Policy Gate。

- [ ] **Step 1: Write RED tests for durable admission and worker-loss resume**

  Add a durable fixture with persisted steps, timer/cross-service requirement, worker loss, retry, cancellation, and idempotency assertions.

  Run: `npm test -- --run tests/durable`

  Expected: RED because the durable adapter and admission policy do not exist.

- [ ] **Step 2: Implement the durable WorkflowRuntime adapter**

  Preserve IAR workflow identity, event/policy/idempotency events, step persistence, retry/cancel/timeout, and resume semantics while delegating durable execution only when admitted.

  Run: `npm test -- --run tests/durable`

  Expected: GREEN; worker loss resumes from the last persisted step without duplicating a side effect.

- [ ] **Step 3: Implement signed remote plugin distribution and ABI compatibility**

  Add signed metadata, version/dependency/capability approval, cross-language contract fixtures, and rollback records under `packages/plugin-distribution/` and `packages/abi/`.

  Run: `npm test -- --run tests/distribution tests/compatibility`

  Expected: GREEN; invalid signatures, incompatible versions, and capability expansion are rejected.

- [ ] **Step 4: Implement multi-tenant control-plane operations**

  Add tenant-scoped install, upgrade, enable, disable, rollback and audit operations without changing runtime authorization semantics.

  Run: `npm test -- --run tests/distribution tests/compatibility`

  Expected: GREEN; remote plugins obey the same Manifest, Schema, tenant, Policy Gate, audit, and lifecycle contracts.

- [ ] **Step 5: Run Phase 5 broader verification and final audit**

  Run: `npm run lint && npm run build && npm test` plus worker-loss, migration, rollback, and compatibility integration commands.

  Expected: all five capability specs, the seven documented acceptance criteria, and every OpenSpec task have implementation and test evidence.

## Source references

- Requirements: `docs/README.md`
- Contract examples: `docs/references/插件Manifest示例.yaml`、`docs/references/路由规则示例.yaml`、`docs/references/行为上下文示例.json`
- Hook/logging examples: `docs/references/Hook订阅示例.yaml`、`docs/references/内置日志插件示例.yaml`
- Compaction contract: `docs/references/上下文压缩提示词示例.md`
- OpenSpec source of truth: `openspec/changes/iar-five-phase-roadmap/`
