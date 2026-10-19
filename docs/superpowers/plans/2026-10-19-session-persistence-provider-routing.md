# 会话持久化 Provider 与范围路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Plugin 优先范围路由、实时结构化上下文、可替换持久化 Provider、内置 SQLite 和基于 `sessionId` 的恢复链路。

**Architecture:** Core 依赖版本化 Persistence SPI，内置 SQLite 和外部包都是 Provider；Hook/StateEvent 负责异步投递消息、事件和上下文快照。路由先确定 Plugin，再在 Plugin 内按固定 action type 筛选 Function，当前范围存入 BehaviorContext。

**Tech Stack:** TypeScript、Node.js、Fastify、SQLite worker、现有 `@iar/contracts`、`@iar/runtime`、`@iar/subscriptions`、现有测试运行器。

---

### Task 1: 定义会话身份和 Persistence SPI

**Files:**
- Create: `packages/persistence-spi/src/types.ts`
- Create: `packages/persistence-spi/src/index.ts`
- Create: `packages/persistence-spi/package.json`
- Create: `packages/persistence-spi/index.js`
- Test: `tests/contract/persistence-provider.test.ts`

- [x] **Step 1: Write the failing contract test** — 验证合法 `SessionIdentity`、Provider Manifest、版本和边界错误；在接口不存在时确认编译失败。
- [x] **Step 2: Implement the SPI** — 定义 Provider、工厂、Manifest、消息、快照和稳定校验错误；所有持久化写入接口均接收 `sessionId`。
- [x] **Step 3: Verify** — `node scripts/run-tests.mjs tests/contract/persistence-provider.test.ts` 通过；独立 `npx tsc --noEmit --ignoreConfig --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node packages/persistence-spi/src/index.ts tests/contract/persistence-provider.test.ts` 通过。

### Task 2: 内置 SQLite Provider 和 Provider Registry

**Files:**
- Create: `packages/persistence-sqlite/src/provider.ts`
- Create: `packages/persistence-sqlite/src/worker.ts`
- Create: `packages/persistence-sqlite/src/index.ts`
- Create: `packages/persistence-sqlite/package.json`
- Create: `packages/persistence-runtime/src/registry.ts`
- Create: `packages/persistence-runtime/src/loader.ts`
- Test: `tests/integration/persistence-provider.test.ts`

- [x] **Step 1: Write the failing tests** — 覆盖内置 SQLite 默认 Provider、消息保存、事件幂等、快照 revision、动态 Provider 加载和错误配置。
- [x] **Step 2: Implement the adapters** — 通过独立 SQLite Worker 实现 Provider，增加消息/事件/快照表、Registry 和动态 import 校验。
- [x] **Step 3: Verify** — 聚焦 Provider 测试和 SQLite 重启恢复测试通过；全仓构建的既有 worktree 重复类型问题单独记录，合并到主分支后复核。

### Task 3: Hook 事件和持久化订阅桥

**Files:**
- Modify: `packages/subscriptions/src/events.ts`
- Modify: `packages/subscriptions/src/types.ts`
- Modify: `packages/subscriptions/src/dispatcher.ts`
- Modify: `packages/contracts/src/types-state.ts`
- Modify: `packages/contracts/src/schema-events.ts`
- Create: `packages/persistence-runtime/src/subscriber.ts`
- Modify: `packages/runtime/src/context-projector.ts`
- Modify: `examples/agent-sandbox/src/session-core.ts`
- Modify: `examples/agent-sandbox/src/session-types.ts`
- Test: `tests/contract/persistence-subscription.test.ts`

- [x] **Step 1: Write the failing tests** — 覆盖 `message.received`、`message.sent`、`context.updated`、`session.restored` 的异步订阅、幂等、重试和队列边界。
- [x] **Step 2: Implement the bridge** — 让事件携带统一 SessionIdentity，由 Provider 订阅桥保存消息和快照，不直接依赖 SQLite。
- [x] **Step 3: Verify** — 新增订阅契约、旧订阅回归和 Provider 恢复测试通过；Sandbox 全链路接入留在 Task 5。

### Task 4: Plugin 优先和 actionType 范围路由

**Files:**
- Modify: `packages/contracts/src/types-base.ts`
- Modify: `packages/contracts/src/schema-primitives.ts`
- Modify: `packages/contracts/src/types-state.ts`
- Modify: `packages/contracts/src/schema-context.ts`
- Modify: `packages/runtime/src/routing.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session-dependencies.ts`
- Test: `tests/routing/scoped-plugin-routing.test.ts`

- [ ] **Step 1: Write the failing tests** — 覆盖不构造全局 `query` 候选、范围复用、显式切换、未知动作拒绝和模型不具备授权能力。
- [ ] **Step 2: Implement scoped routing** — 为 Function Manifest 增加固定 action vocabulary，为 BehaviorContext 增加 bounded routing scope，Plugin 优先后再按动作过滤 Function。
- [ ] **Step 3: Verify** — 路由聚焦测试、JEV/Intent Model 回归和全量测试通过。

### Task 5: sessionId 标准化、恢复入口和文档

**Files:**
- Modify: `examples/agent-sandbox/src/session-manager.ts`
- Modify: `examples/agent-sandbox/src/http-lifecycle-routes.ts`
- Modify: `examples/agent-sandbox/src/http-reservation.ts`
- Modify: `examples/agent-sandbox/src/server.ts`
- Modify: `examples/agent-sandbox/src/env.ts`
- Modify: `README.md`
- Modify: `docs/README.md`
- Test: `tests/integration/agent-sandbox/session-resume-provider.test.ts`

- [ ] **Step 1: Write the failing tests** — 覆盖新建/恢复会话、跨会话隔离、模型决策前恢复上下文和默认 SQLite Provider。
- [ ] **Step 2: Implement session wiring** — 让 HTTP、Runtime、Hook 和 Provider 贯穿同一 `sessionId`，默认加载内置 SQLite，支持外部 Provider 配置。
- [ ] **Step 3: Verify and document** — 更新根 README、技术方案和接入示例；运行 `npm test`、`npm run build` 和 `openspec validate session-persistence-provider-routing --strict`。

## Workflow follow-up

- 每个独立任务通过 TDD、代码审查、聚焦验证和提交后，再从 `master` 创建下一个任务 worktree 并合并回 `master`。
- 所有任务完成后同步批准的结构化上下文、Provider 和范围路由规范到 `openspec/specs/`，然后归档 OpenSpec。
