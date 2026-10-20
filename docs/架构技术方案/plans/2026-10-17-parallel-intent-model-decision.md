# Parallel Intent Model Decision Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** 在不改变下游 \`DecisionResult\` 协议的前提下，为 Function/Plugin 选择增加普通意图模型后端，并实现 JEV 优先、Intent Model 可替代的兼容切换。

**Architecture:** 在 \`packages/decision\` 增加显式 \`DecisionBackend\` 配置和 resolver。JEV Adapter 与 Intent Model Adapter 都通过 \`ModelGateway\` 返回同一 \`iar.decision/v1\`，由现有 \`validateDecisionOutput\` 统一完成候选集、版本、分数和阈值校验。Intent Model 只提供候选选择建议，最终的 Function-first、Plugin ownership、权限、能力和 Policy 复核保持在运行时。

**Tech Stack:** TypeScript、Node.js 24、npm workspaces、TypeBox/Ajv contract validation、Node test runner、JSON-compatible YAML model profiles。

---

## Scope and file map

### Configuration and contract boundary

- Modify: \`packages/decision/src/types.ts\`：增加 \`DecisionBackend\` 类型和 backend 选择输入类型。
- Modify: \`packages/decision/src/model-profile.ts\`：校验 \`decisionBackend\`、同 role/backend 的 primary/fallback 关系，并提供 backend-aware profile 查询。
- Modify: \`packages/decision/src/model-gateway/types.ts\`：让 \`ModelGateway.invoke\` 接收可选 backend 选择参数，保持 \`ModelGatewayResult<T>\` 不变。
- Modify: \`packages/decision/src/model-gateway/gateway.ts\`：按 resolver 结果加载 profile，保留现有 timeout/retry/fallback/redaction/audit 逻辑。
- Create: \`packages/decision/src/model-gateway/decision-backend.ts\`：实现 \`DecisionBackendResolver\` 和统一 decision adapter 工厂。
- Modify: \`packages/runtime/src/routing.ts\`：增加不破坏同步 \`route()\` 的异步模型路由入口，继续复用 Function-first、Plugin ownership 和最终授权复核。

### Intent Model adapter

- Create: \`packages/decision/src/model-gateway/intent-prompt.ts\`：保存 \`iar.intent-decision-prompt/v1\` 和固定 JSON-only Prompt builder。
- Create: \`packages/decision/src/model-gateway/intent-model-adapter.ts\`：把 DecisionRequest 包装为 Intent Model 输入，并复用 \`validateDecisionOutput\`。
- Modify: \`packages/decision/src/model-gateway/adapters.ts\`：保留 \`JevDecisionAdapter\`，让其和 Intent Model adapter 使用相同的 request/validation 边界。
- Modify: \`packages/decision/src/model-gateway/index.ts\`、\`packages/decision/src/index.ts\`：导出新增类型、Prompt 版本和 adapter。

### Configuration, tests, and docs

- Modify: \`config/models.yaml\`：给 \`function.select\`、\`plugin.select\` 的 JEV profile 标注 \`decisionBackend: "jev"\`，增加可选 Intent Model profile 示例。
- Modify: \`.env.example\`：增加 Intent Model provider 所需的环境变量占位说明，不写入真实密钥。
- Modify: \`tests/integration/model-gateway/model-profile.test.ts\`：覆盖 backend profile 校验和优先级。
- Modify: \`tests/integration/model-gateway/model-gateway.test.ts\`：覆盖统一 adapter 和 Prompt 输出。
- Create: \`tests/integration/model-gateway/intent-model-decision.test.ts\`：覆盖 Intent Model 合法/非法输出和审计。
- Modify: \`tests/routing/two-stage-router.test.ts\`、\`tests/security/phase-4-security.test.ts\`：验证两种后端输出仍受同一候选、权限和能力复核约束。
- Modify: \`docs/架构技术方案/README.md\`、\`README.md\`：记录 JEV/Intent Model 的统一输出、优先级和不授予权限边界。
- Create: \`docs/implementation-audits/parallel-intent-model-decision.md\`：记录最终审计和验证证据。

## Task 1: Add explicit decision backend configuration

**Files:**

- Modify: \`packages/decision/src/types.ts\`
- Modify: \`packages/decision/src/model-profile.ts\`
- Modify: \`packages/decision/src/model-gateway/types.ts\`
- Create: \`packages/decision/src/model-gateway/decision-backend.ts\`
- Test: \`tests/integration/model-gateway/model-profile.test.ts\`

- [ ] **Step 1: Write failing profile tests**

Add tests that load these profiles:

~~~ts
const profiles = [
  profile('function-jev-primary', 'function.select', 'jev'),
  profile('function-jev-fallback', 'function.select', 'jev'),
  profile('function-intent-primary', 'function.select', 'intent-model')
];
~~~

The tests must assert:

- both backends resolve \`jev\` first;
- removing the JEV profiles resolves \`intent-model\`;
- duplicate primary profiles for one \`role + decisionBackend\` throw during registry creation;
- a fallback pointing to another backend throws during registry creation;
- \`semantic.extract\` cannot carry \`decisionBackend\`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/model-profile.test.ts
~~~

Expected: FAIL because \`decisionBackend\` is not yet part of \`ModelProfile\` and no backend-aware resolver exists.

- [ ] **Step 3: Add the backend type and profile validation**

Add the exact backend union:

~~~ts
export type DecisionBackend = 'jev' | 'intent-model';
~~~

Add \`decisionBackend?: DecisionBackend\` to \`ModelProfile\`. Update the profile key whitelist and parser so that:

- selection roles require \`decisionBackend\`;
- non-selection roles reject \`decisionBackend\`;
- \`fallbackProfileId\` resolves to the same \`role\` and \`decisionBackend\`;
- each role/backend has exactly one primary profile, with fallback profiles reachable only through a primary profile.

Keep \`provider\` unchanged as the registered provider name. Do not overload it with backend semantics.

- [ ] **Step 4: Implement \`DecisionBackendResolver\`**

Expose:

~~~ts
export type DecisionBackendResolution = {
  role: 'function.select' | 'plugin.select';
  backend: DecisionBackend;
  profileId: string;
};

export class DecisionBackendResolver {
  public constructor(private readonly registry: ModelProfileRegistry) {}
  public resolve(role: 'function.select' | 'plugin.select'): DecisionBackendResolution;
}
~~~

\`resolve()\` must inspect the registry and select \`jev\` before \`intent-model\`. It must throw a stable configuration error when neither backend has a primary profile. It must never invoke both backends.

- [ ] **Step 5: Run focused tests and commit Task 1**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/model-profile.test.ts
npm run lint
~~~

Expected: all focused tests PASS and TypeScript has no errors.

Commit:

~~~bash
git add packages/decision/src/types.ts packages/decision/src/model-profile.ts packages/decision/src/model-gateway/types.ts packages/decision/src/model-gateway/decision-backend.ts tests/integration/model-gateway/model-profile.test.ts
git commit -m "✨ feat(decision): 增加决策后端优先级配置"
~~~

## Task 2: Implement the JEV-compatible Intent Model adapter

**Files:**

- Create: \`packages/decision/src/model-gateway/intent-prompt.ts\`
- Create: \`packages/decision/src/model-gateway/intent-model-adapter.ts\`
- Modify: \`packages/decision/src/model-gateway/gateway.ts\`
- Modify: \`packages/decision/src/model-gateway/adapters.ts\`
- Modify: \`packages/decision/src/model-gateway/index.ts\`
- Test: \`tests/integration/model-gateway/intent-model-decision.test.ts\`

- [ ] **Step 1: Write failing adapter tests**

Use a mock \`ModelProvider\` that captures \`request.input\` and returns each fixture below.

Valid fixture:

~~~ts
{
  schemaVersion: 'iar.decision/v1',
  decisionType: 'function.select',
  decisionVersion: 'runtime.v1',
  status: 'choice',
  choice: 'candidate-a',
  score: 0.94,
  reasonCode: 'intent_match',
  candidateIds: ['candidate-a', 'candidate-b']
}
~~~

Invalid fixtures must include an unknown choice, a reordered \`candidateIds\`, a mismatched decision version, a score below threshold, a non-JSON return, and an extra output field. Assert that every result is a \`ModelGatewayResult<DecisionResult>\` and no raw provider value escapes.

- [ ] **Step 2: Run the adapter tests and confirm RED**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/intent-model-decision.test.ts
~~~

Expected: FAIL because the Intent Model prompt and adapter do not exist.

- [ ] **Step 3: Add the versioned Prompt builder**

Define:

~~~ts
export const INTENT_DECISION_PROMPT_VERSION = 'iar.intent-decision-prompt/v1';
export const INTENT_DECISION_SYSTEM_PROMPT = [
  'You are the IAR intent decision model.',
  'Return JSON only. Do not return Markdown, prose, tools, or code fences.',
  'Return exactly iar.decision/v1 with schemaVersion, decisionType, decisionVersion, status, choice, score, reasonCode, and candidateIds.',
  'Copy decisionType, decisionVersion, and candidateIds exactly and preserve candidateIds order.',
  'choice must be one of candidateIds. Do not create candidates, grant capabilities, authorize actions, or execute plugins.',
  'Use needs_clarification when candidates are ambiguous or score is below threshold; use noul when no candidate matches.'
].join('\\n');

export function buildIntentDecisionInput(request: DecisionRequest): JsonValue {
  return {
    promptVersion: INTENT_DECISION_PROMPT_VERSION,
    systemPrompt: INTENT_DECISION_SYSTEM_PROMPT,
    request: structuredClone(request)
  };
}
~~~

The Prompt must require JSON-only \`iar.decision/v1\`, exact copying of \`decisionType\`, \`decisionVersion\`, and ordered \`candidateIds\`, and must forbid candidate creation, capability grants, authorization, tool calls, and plugin execution.

- [ ] **Step 4: Add \`IntentModelDecisionAdapter\`**

Expose:

~~~ts
export class IntentModelDecisionAdapter {
  public constructor(private readonly gateway: ModelGateway) {}

  public decide(invocation: JevDecisionInvocation): Promise<ModelGatewayResult<DecisionResult>>;
}
~~~

The adapter must:

1. reject malformed or mismatched \`DecisionRequest\` before provider invocation;
2. build the versioned Prompt input;
3. call \`ModelGateway.invoke('function.select' | 'plugin.select', ...)\` with \`decisionBackend: 'intent-model'\`;
4. validate through the same \`validateDecisionResult()\` path used by JEV;
5. preserve stable errors and never expose raw prompt/user input in error details.

- [ ] **Step 5: Add backend-neutral adapter selection**

Add \`UnifiedDecisionAdapter\` using \`DecisionBackendResolver\`. Its \`decide()\` method delegates to \`JevDecisionAdapter\` when the resolver returns \`jev\`, otherwise to \`IntentModelDecisionAdapter\`. The public return type remains \`Promise<ModelGatewayResult<DecisionResult>>\`; no downstream caller can branch on backend-specific output.

- [ ] **Step 6: Run focused tests and commit Task 2**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/intent-model-decision.test.ts tests/integration/model-gateway/model-gateway.test.ts
npm run lint
~~~

Expected: all focused tests PASS, including the existing JEV adapter tests.

Commit:

~~~bash
git add packages/decision/src/model-gateway tests/integration/model-gateway/intent-model-decision.test.ts
git commit -m "✨ feat(decision): 添加统一意图模型决策适配器"
~~~

## Task 3: Wire precedence and failure semantics

**Files:**

- Modify: \`packages/decision/src/model-gateway/gateway.ts\`
- Modify: \`packages/decision/src/model-gateway/decision-backend.ts\`
- Modify: \`packages/decision/src/model-gateway/types.ts\`
- Test: \`tests/integration/model-gateway/model-gateway.test.ts\`
- Test: \`tests/routing/two-stage-router.test.ts\`
- Test: \`tests/security/phase-4-security.test.ts\`

- [ ] **Step 1: Write precedence and failure tests**

Assert these exact behaviors:

1. JEV and Intent Model are both configured: only JEV provider is called.
2. JEV is absent: only Intent Model provider is called.
3. JEV returns \`needs_clarification\`: Intent Model is not called.
4. JEV returns provider failure: Intent Model is not called unless \`crossBackendFallback: true\` is explicitly configured.
5. Explicit cross-backend fallback records \`fallbackUsed: true\` and both attempts in audit order.
6. A valid Intent Model choice still fails if the selected Plugin is disabled, unauthorized, owned by another Function, or lacks capability.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/model-gateway.test.ts tests/routing/two-stage-router.test.ts tests/security/phase-4-security.test.ts
~~~

Expected: new backend precedence and cross-backend fallback assertions fail while the existing JEV and security tests continue to pass.

- [ ] **Step 3: Implement explicit precedence without changing \`DecisionResult\`**

Keep \`DecisionResult\`, \`RouteResult\`, and public error codes stable. Pass only backend selection metadata through the ModelGateway invocation options. The resolver must make one backend choice before provider invocation; the gateway must keep same-backend profile fallback behavior unchanged.

Do not change the synchronous \`DecisionProvider\` interface or \`packages/runtime/src/routing.ts\` in this task. The latest runtime uses a synchronous deterministic provider boundary, while \`ModelGateway` adapters are asynchronous; expose the unified adapter at the existing ModelGateway boundary and leave \`TwoStageRouter\` backward-compatible. A later async orchestration change can consume this adapter without changing its output contract.

- [ ] **Step 4: Verify authority revalidation**

Run the routing/security tests and assert that a model result only changes \`functionDecision\`/\`pluginDecision\` evidence. It must not modify \`PluginHost\`, capabilities, tenant, actor, environment, Policy Gate, or Workflow state.

- [ ] **Step 5: Commit Task 3**

Implementation note: the synchronous `DecisionProvider` and existing `TwoStageRouter.route()` contract remain unchanged. Task 3 adds a backward-compatible `routeAsync()` entry so the asynchronous `UnifiedDecisionAdapter` can be used by Function/Plugin stages without changing `RouteResult` or final authority checks.

Run:

~~~bash
npm test -- --run tests/integration/model-gateway/model-gateway.test.ts tests/routing/two-stage-router.test.ts tests/security/phase-4-security.test.ts
npm run lint
npm run build
~~~

Commit:

~~~bash
git add packages/decision/src/model-gateway tests/integration/model-gateway/model-gateway.test.ts tests/routing/two-stage-router.test.ts tests/security/phase-4-security.test.ts
git commit -m "✨ feat(runtime): 接入 JEV 优先的决策后端选择"
~~~

## Task 4: Update configuration, documentation, and acceptance audit

**Files:**

- Modify: \`config/models.yaml\`
- Modify: \`.env.example\`
- Modify: \`docs/架构技术方案/README.md\`
- Modify: \`README.md\`
- Create: \`docs/implementation-audits/parallel-intent-model-decision.md\`
- Test: \`tests/integration/model-gateway/model-profile.test.ts\`

- [ ] **Step 1: Add safe configuration examples**

Mark existing selection profiles with \`decisionBackend: "jev"\` and add disabled-by-default Intent Model examples with \`decisionBackend: "intent-model"\`. Keep provider names explicit and keep all secrets as environment references or absent placeholders.

- [ ] **Step 2: Document the stable output contract**

Document the exact JSON shape:

~~~json
{
  "schemaVersion": "iar.decision/v1",
  "decisionType": "function.select",
  "decisionVersion": "runtime.v1",
  "status": "choice",
  "choice": "candidate-id",
  "score": 0.95,
  "reasonCode": "intent_match",
  "candidateIds": ["candidate-id"]
}
~~~

Also document:

- JEV wins when both backends exist;
- Intent Model is used when JEV is absent;
- low confidence remains \`needs_clarification\`;
- backend selection never grants authority;
- Prompt version is \`iar.intent-decision-prompt/v1\`.

- [ ] **Step 3: Write the implementation audit**

The audit must list each completed task, each acceptance scenario, focused tests, full tests, and any intentionally unchanged API. It must explicitly state that \`DecisionResult\` remains unchanged and that existing untracked symlinks were not touched.

- [ ] **Step 4: Run documentation and full verification**

Run:

~~~bash
openspec validate parallel-intent-model-decision --strict
git diff --check
npm run lint
npm run build
npm test
~~~

Expected: OpenSpec valid, no whitespace errors, lint/build pass, and the full suite remains green.

- [ ] **Step 5: Commit Task 4**

~~~bash
git add config/models.yaml .env.example docs/架构技术方案/README.md README.md docs/implementation-audits/parallel-intent-model-decision.md tests/integration/model-gateway/model-profile.test.ts
git commit -m "📝 docs(decision): 补充意图模型兼容配置与边界"
~~~

## Task 5: Final audit and archive

- [ ] **Step 1: Confirm implementation matches the OpenSpec delta**

Check every modified/added requirement in \`openspec/changes/parallel-intent-model-decision/specs/bounded-routing/spec.md\` against code and tests. Confirm there are no unchecked tasks, no unreviewed backend-specific outputs, and no implicit cross-backend fallback.

- [ ] **Step 2: Run the final acceptance matrix**

Run:

~~~bash
npm test -- --run tests/integration/model-gateway tests/routing tests/security
npm run lint
npm run build
npm test
git diff --check
~~~

Expected: focused model/routing/security tests pass, then the full suite passes without changing existing route or authorization semantics.

- [ ] **Step 3: Archive the completed OpenSpec change**

After the audit passes, sync the modified \`bounded-routing\` spec to \`openspec/specs/bounded-routing/spec.md\`, archive the change under \`openspec/changes/archive/YYYY-MM-DD-parallel-intent-model-decision/\`, and verify \`openspec list --json\` has no active change for this feature.

- [ ] **Step 4: Integrate and verify \`master\`**

Merge the task branch into \`master\`, verify ancestry, preserve the six pre-existing untracked symlinks, and report the final commit and test evidence.
