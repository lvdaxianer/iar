# IAR ↔ Pi Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不修改 Pi 核心的前提下，交付可安装的 `@iar/pi-bridge` 和 IAR `/api/bridge/v1`，让 IAR 处理业务意图、动作和确认，让普通输入继续进入 Pi Agent。

**Architecture:** IAR Bridge HTTP API 复用现有 SandboxSessionManager 的串行会话；`bridgeTurn` 在明确 `noul` 且没有 IAR 上下文时返回 `pass_through`。`@iar/pi-bridge` 只依赖 Fetch 和 Pi 扩展的最小结构类型，在 `input` 钩子中调用 IAR，非 pass-through 通过不进入 LLM context 的 display-only custom entry 展示并 handled；确认/取消由显式命令直达 IAR。

**Tech Stack:** Node.js 24、TypeScript ESM、Fastify、Node test runner、Pi Extension API。

---

### Task 1: 固化桥接协议和可发布包边界

**Files:**
- Create: `packages/adapters/pi/package.json`
- Create: `packages/adapters/pi/tsconfig.build.json`
- Create: `packages/adapters/pi/src/protocol.ts`
- Create: `packages/adapters/pi/src/index.ts`
- Modify: `tsconfig.build.json`
- Test: `tests/integration/tooling/package-manager-startup.test.ts` or a new package smoke test

- [ ] **Step 1: Write the failing protocol/package test**

  Add a test that imports `@iar/pi-bridge` from its public source boundary, checks `PI_BRIDGE_VERSION`, validates all four dispositions, and verifies package metadata declares `pi.extensions`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run `npm run build -- --pretty false` and the focused compiled test. Expected: package entry or protocol exports do not exist.

- [ ] **Step 3: Implement the minimal protocol package**

  Define `BridgeDisposition`, bounded request/response types, `BridgeClientError` contract types, public exports, package `exports`, `files: ["dist"]`, and `pi.extensions: ["./dist/pi-extension.js"]`. Add the project reference so clean builds compile the package before examples/tests.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run `npm run lint` and the package smoke test. Expected: public exports and package metadata pass type checking.

- [ ] **Step 5: Commit**

  Run `git add packages/adapters/pi tsconfig.build.json tests` and commit with `feat: 定义 Pi 桥接公共契约`.

### Task 2: 实现 IAR Bridge Client 和 Pi Extension

**Files:**
- Create: `packages/adapters/pi/src/client.ts`
- Create: `packages/adapters/pi/src/extension.ts`
- Create: `packages/adapters/pi/src/pi-extension.ts`
- Modify: `packages/adapters/pi/src/index.ts`
- Test: `tests/integration/pi-bridge/client.test.ts`

- [ ] **Step 1: Write failing client and extension tests**

  Stub `fetch` and a minimal Pi API. Assert open/input/confirm URLs and bounded JSON; `pass_through` returns `{action:"continue"}`; `handled`, clarification and awaiting confirmation append one display-only entry and return `{action:"handled"}`; `source:"extension"` does not call Fetch; timeout/error shows a bounded error and returns handled; `/iar-confirm` forwards the stored action ID.

- [ ] **Step 2: Run tests and verify they fail**

  Run `npm run build` and the focused test. Expected: missing client/extension exports and handlers.

- [ ] **Step 3: Implement client with timeout and response validation**

  Add `IarBridgeClient` with `openSession`, `input`, `confirm`, and `state`; use `AbortSignal.timeout`, validate response version/disposition/session ID, classify HTTP/JSON/timeout errors, and call optional debug/warn logger without logging message or action input.

- [ ] **Step 4: Implement extension lifecycle and routing**

  On `session_start`, call `openSession(ctx.sessionManager.getSessionId())`; on `input`, skip extension-originated messages, call IAR, continue only for pass-through, otherwise append a display-only `iar-bridge` entry and handle. Register `iar-confirm` and `iar-cancel`; clean local pending state on `session_shutdown`. Export a default Pi Package entry from `pi-extension.ts`.

- [ ] **Step 5: Run tests and verify they pass**

  Run `npm run lint` and the focused compiled test. Expected: all client/extension behavior passes without a Pi runtime dependency.

- [ ] **Step 6: Commit**

  Commit with `feat: 实现 Pi 桥接扩展与客户端`.

### Task 3: 为 IAR Sandbox 增加 bridge turn 和 HTTP API

**Files:**
- Modify: `examples/agent-sandbox/src/session-types.ts`
- Modify: `examples/agent-sandbox/src/session.ts`
- Create: `examples/agent-sandbox/src/http-pi-bridge-routes.ts`
- Modify: `examples/agent-sandbox/src/http-transport.ts`
- Modify: `examples/agent-sandbox/src/http-reservation.ts`
- Modify: `examples/agent-sandbox/src/request-audit.ts`
- Modify: `examples/agent-sandbox/src/safe-log.ts`
- Test: `tests/integration/agent-sandbox/pi-bridge.test.ts`

- [ ] **Step 1: Write failing IAR bridge tests**

  Start the scripted Sandbox server and assert: bridge session open maps the same Pi key to the same IAR session; an unknown input returns `pass_through`; a known business input returns a non-pass-through response; pending confirmation is returned with action ID; confirm/cancel are serialized and stale action IDs are rejected; malformed body and oversized input are rejected; two Pi keys cannot share pending state.

- [ ] **Step 2: Run the focused integration test and verify it fails**

  Run `npm run build && node scripts/run-tests.mjs tests/integration/agent-sandbox/pi-bridge.test.ts`. Expected: bridge routes and `bridgeTurn` are missing.

- [ ] **Step 3: Add the pass-through result and session entry**

  Extend `TurnResult` with `pass_through`, add `bridgeTurn(text)` and reuse the existing turn pipeline. Return pass-through only for route `noul` with no pending clarification/reference and no verified-fact follow-up; leave existing `/api/chat` behavior unchanged.

- [ ] **Step 4: Add bridge routes and mapping directory**

  Register `POST /api/bridge/v1/sessions`, `POST /api/bridge/v1/sessions/:sessionId/input`, `POST /api/bridge/v1/sessions/:sessionId/confirm`, and `GET /api/bridge/v1/sessions/:sessionId/state`. Validate IDs/messages, map Pi keys to manager-created sessions, invoke manager `run` so requests remain serialized, and translate TurnResult/ConfirmResult to the versioned disposition contract. Never echo raw request text or internal exceptions.

- [ ] **Step 5: Extend audit and reservation allowlists**

  Add the four bridge paths to safe request logging and reserve input/confirm/state operations through the existing session queue. Ensure only the bridge input route consumes mutation budget.

- [ ] **Step 6: Run focused and regression tests**

  Run `npm run build && node scripts/run-tests.mjs tests/integration/agent-sandbox/pi-bridge.test.ts tests/integration/agent-sandbox/session-confirm-validation.test.ts tests/integration/agent-sandbox/session-isolation.test.ts`. Expected: focused bridge tests and existing session tests pass.

- [ ] **Step 7: Commit**

  Commit with `feat: 增加 IAR Pi 桥接 HTTP 入口`.

### Task 4: 文档、包分发检查和全量验证

**Files:**
- Modify: `README.md`
- Modify: `scripts/verify-package-distribution.mjs` only if the generic checker needs the new package declared
- Test: `tests/integration/tooling/package-manager-startup.test.ts` and package distribution smoke checks

- [ ] **Step 1: Document installation and session ownership**

  Add CLI install, SDK `extensionFactories` example, `IAR_PI_BRIDGE_URL`, fail-closed behavior, explicit confirm/cancel commands, and the Pi-session/IAR-session ownership rule.

- [ ] **Step 2: Run package verification**

  Run `npm run verify:packages`. Expected: every package public entry, declaration and archive boundary passes.

- [ ] **Step 3: Run full lint, build and tests**

  Run `npm run lint`, `npm run build`, and `npm test`. Expected: exit code 0 with no test discovery gaps.

- [ ] **Step 4: Review diff and audit**

  Run `git diff --check`, `git diff --stat`, inspect all changed files for unsafe logs, unresolved promises, unbounded input, and accidental Pi source changes; verify `git -C /Users/lvdaxianer/workspace/my/project/pi status --short` is unchanged.

- [ ] **Step 5: Commit documentation and verification updates**

  Commit with `docs: 补充 IAR Pi 桥接使用说明`.
