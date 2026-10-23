# 分层 Function/参数收集与稳定路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Plugin/Function 路由、Function 需求收集、参数收集、确认和执行拆成可恢复的运行时状态机，并用完整的双语安全日志证明每一轮到底缺少什么、为什么反问、为什么没有执行。

**Architecture:** Function ID 是执行边界，Plugin ID 是实现归属；当 Function 未确定时进入 Function 收集器，当 Function 已确定但输入 Schema 不满足时进入参数收集器。模型只负责生成结构化候选（标识、操作、参数），程序负责注册表解析、Schema 校验、状态合并、冲突处理、反问、确认和执行；模型失败时使用确定性结果，不使用 Response Model 猜测或授权执行。

**Tech Stack:** TypeScript、Node.js、Fastify bridge、`@iar/contracts` JSON Schema/Ajv 校验、`@iar/runtime` ModelGateway、现有 Sandbox Web UI、Node test runner、OpenSpec。

---

## 现状与范围

本计划合并现有 OpenSpec `recover-semantic-routing-gaps` 的未完成项：

- 完成模型每次 attempt、参数边界、路由门禁和桥接失败的完整日志。
- 完成缺字段的持久化恢复、重新抽取和重新校验。
- 将“命中 Plugin 但没有 Function”和“命中 Function 但参数不完整”拆成两个收集器。
- 删除本轮新增的业务专用语义补丁；收集器只能读取 Function 注册表和 JSON Schema。
- 保留已经完成的总耗时、阶段耗时、Trace ID、双语日志和最终 Response Model 思考展示行为；新增回归测试证明抽取模型不会显示思考内容，只有最终生成模型允许显示并收起思考内容。
- 保留 OpenAI-compatible Function `parameters`，界面中文字段和控件定义放在运行时独立的 presentation metadata 中。

不在本计划内：新增任何工单、限流、告警等业务规则；通过关键词替代语义模型；把模型正文、原始用户消息、API Key 或 thinking 原文写入生产日志；让响应模型决定是否执行。

## 持久化数据设计

在 `BehaviorContext` 中增加有界的收集状态，所有 ID 和字段都来自已注册能力或 Function Schema：

```ts
type CollectionState =
  | {
      kind: 'function';
      pluginId?: string;
      candidateFunctionIds: string[];
      reasonCode: 'function_missing' | 'function_ambiguous';
      attempt: number;
    }
  | {
      kind: 'parameters';
      functionId: string;
      pluginId?: string;
      schemaVersion: string;
      collected: Record<string, JsonValue>;
      missingFields: string[];
      invalidFields: string[];
      conflictFields: string[];
      attempt: number;
    };
```

`collection` 不代表授权，也不代表可以执行；只有 Schema 校验成功并通过确认门禁，才可以构造 `ActionDefinition`。

## 触发规则

```text
Function 已确定且可解析
  ├─ Schema 参数完整合法
  │   ├─ read/query → 执行
  │   └─ action → confirmation
  └─ 参数缺失、非法或冲突 → 参数收集器

Function 未确定
  ├─ Plugin 未确定 → Plugin 澄清/候选选择
  ├─ Plugin 已确定且只有一个 Function → 程序自动绑定，不反问
  └─ Plugin 已确定且 Function 不唯一 → Function 收集器
```

Function ID 唯一时，Plugin ID 可以由注册表反查；如果 Function ID 在多个 Plugin 中重复，程序必须报告实现歧义并要求选择 Plugin，不能猜测。

## 分层职责

| 阶段 | 模型做什么 | 程序做什么 | 是否允许执行 |
|---|---|---|---|
| `semantic.extract` | 提取候选 Function/Plugin、操作和参数 | 校验结构、过滤未知 ID | 否 |
| Function 收集 | 将用户的中文回答映射到候选 Function ID | 展示中文能力选项、固定候选范围 | 否 |
| 参数收集 | 只在固定 Function Schema 范围内抽取字段 | 合并、类型/枚举/required/冲突校验 | 否 |
| confirmation | 不负责补参数 | 校验 Action scope hash 和授权 | 否，等待用户 |
| Function 执行 | 不参与执行决策 | 创建并执行 Action | 是 |
| `response.generate` | 汇总执行结果并生成最终文本 | 限制输入范围，不读取回复来授权 | 执行已结束 |

---

### Task 1: Reconcile existing diagnostics and remove business-specific recovery

**Files:**
- Modify: `examples/agent-sandbox/src/models/scripted-provider.ts`
- Modify: `examples/agent-sandbox/src/session-turn-helpers.ts`
- Modify: `tests/integration/agent-sandbox/semantic-routing-recovery.test.ts`
- Modify: `openspec/changes/recover-semantic-routing-gaps/tasks.md`
- Test: `tests/integration/model-gateway/model-gateway.test.ts`

- [x] **Step 1: Write the failing generic regression test**

把现有依赖 `api.gateway`、数字限流值和 `ticket.create` 的新增恢复断言改成合成 Plugin/Function fixture。测试只表达“已有 Function + 新一轮用户补充字段”，不出现业务名词；断言模型输出的 Function ID 必须来自 fixture，不能由 provider 生成新的业务 ID。

- [x] **Step 2: Run the focused test**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/semantic-routing-recovery.test.ts
```

Expected: 删除业务专用分支后，旧业务耦合断言失败；改成合成 fixture 后恢复为可验证的通用行为。

- [x] **Step 3: Implement the generic boundary**

删除本轮新增的针对具体 Function、中文业务词和数字模式的运行时恢复分支；离线 `ScriptedModelProvider` 仅保留既有测试 fixture，不参与生产授权。将 `canPassThrough` 从业务关键词判断改为结构状态判断：存在 `collection`、待确认 Action 或未完成澄清时，不得 pass-through。

- [x] **Step 4: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/semantic-routing-recovery.test.ts tests/integration/agent-sandbox/pi-bridge.test.ts
git add examples/agent-sandbox/src/models/scripted-provider.ts examples/agent-sandbox/src/session-turn-helpers.ts tests/integration/agent-sandbox/semantic-routing-recovery.test.ts openspec/changes/recover-semantic-routing-gaps/tasks.md
git commit -m "refactor: remove business-specific routing recovery"
```

Expected: 合成 Function 恢复通过，普通聊天仍可 pass-through，待收集状态不会交给 Pi Agent。

### Task 2: Complete model-attempt and boundary observability

**Files:**
- Modify: `packages/runtime/src/intent/decision/model-gateway/types.ts`
- Modify: `packages/runtime/src/intent/decision/model-gateway/gateway.ts`
- Modify: `examples/agent-sandbox/src/session-dependencies.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/safe-log.ts`
- Modify: `examples/agent-sandbox/src/turn-timing.ts`
- Test: `tests/integration/model-gateway/model-gateway.test.ts`
- Test: `tests/integration/agent-sandbox/safe-observability.test.ts`

- [x] **Step 1: Add RED tests for every model attempt**

断言 primary、retry、same-backend fallback、cross-backend fallback 都产生一条安全审计，字段包括 `traceId`、`role`、`profileId`、`profileVersion`、`modelId`、`attempt`、`outcome`、`fallbackUsed`；断言没有 prompt、response、用户文本和 thinking 原文。

- [x] **Step 2: Add RED tests for parameter boundaries**

用合成 Schema 覆盖 `expected`、`present`、`missing`、`invalid`、`conflict` 和 `completed`，断言日志只包含字段名、数量、稳定原因码和下一动作。

- [x] **Step 3: Implement the isolated audit callback**

`ModelGateway` 每完成一次 provider attempt 就通知 `onAudit`；审计回调异常必须被隔离，不能改变模型调用结果。Sandbox 通过 `session-dependencies.ts` 和 scripted fallback 注册 `logModelAudit`。

- [x] **Step 4: Wire action boundary logging**

在 `session-routing.ts` 的 Function 解析、输入构建和 Schema 校验边界记录 Function/Plugin ID、期望字段数量、实际字段数量、缺失/非法/冲突字段和 `nextAction`，继续使用 `safe-log.ts` 白名单和中英文 formatter。

- [x] **Step 5: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/model-gateway/model-gateway.test.ts tests/integration/agent-sandbox/safe-observability.test.ts
git add packages/runtime/src/intent/decision/model-gateway/types.ts packages/runtime/src/intent/decision/model-gateway/gateway.ts examples/agent-sandbox/src/session-dependencies.ts examples/agent-sandbox/src/session-routing.ts examples/agent-sandbox/src/safe-log.ts examples/agent-sandbox/src/turn-timing.ts tests/integration/model-gateway/model-gateway.test.ts tests/integration/agent-sandbox/safe-observability.test.ts
git commit -m "feat: audit every model attempt and parameter boundary"
```

### Task 3: Add bounded collection state and Schema summaries

**Files:**
- Modify: `packages/contracts/src/types-state.ts`
- Modify: `packages/contracts/src/schema-context.ts`
- Modify: `packages/contracts/src/schema-compaction.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `examples/agent-sandbox/src/collection-types.ts`
- Test: `tests/integration/agent-sandbox/collection-contract.test.ts`

- [x] **Step 1: Write RED contract tests**

验证 Function collector 和 parameter collector 可通过 `behaviorContext` 校验；未知字段、无限候选、过长字段值、未声明授权字段和超过轮次上限必须失败。

- [x] **Step 2: Implement the contract**

在 `BehaviorContext` 中加入可选 `collection`，更新快照、压缩和恢复 Schema；旧快照在没有 `collection` 时保持兼容。

- [x] **Step 3: Implement the generic validation summary**

在 `collection-types.ts` 提供：

```ts
type ParameterValidationSummary = {
  expectedFields: string[];
  presentFields: string[];
  missingFields: string[];
  invalidFields: string[];
  conflictFields: string[];
  valid: boolean;
};
```

实现只能读取 `properties`、`required`、`type`、`enum` 和 `additionalProperties`，不得出现业务字段名。

- [x] **Step 4: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/collection-contract.test.ts
git add packages/contracts/src/types-state.ts packages/contracts/src/schema-context.ts packages/contracts/src/schema-compaction.ts packages/contracts/src/schemas.ts packages/contracts/src/index.ts examples/agent-sandbox/src/collection-types.ts tests/integration/agent-sandbox/collection-contract.test.ts
git commit -m "feat: add bounded collection state contract"
```

### Task 4: Implement the Function collector

**Files:**
- Create: `examples/agent-sandbox/src/function-collector.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session.ts`
- Modify: `examples/agent-sandbox/src/session-stream-turn.ts`
- Modify: `examples/agent-sandbox/src/session-types.ts`
- Test: `tests/integration/agent-sandbox/function-collector.test.ts`

- [x] **Step 1: Write RED trigger-matrix tests**

用合成 Plugin 覆盖：Plugin 未命中、Plugin 唯一 Function 自动绑定、Plugin 多 Function 进入收集、Function ID 唯一但 Plugin 缺失时反查绑定、Function ID 重复时实现歧义阻断。

- [x] **Step 2: Implement deterministic candidate construction**

`function-collector.ts` 只从 `PluginHost` 读取已启用 Function 的 ID、中文 title/description、操作类型和 candidate key，生成有限中文选项；不使用关键词，不允许模型创造候选 ID。

- [x] **Step 3: Persist state and stop normal routing**

创建 Function collector 后写入 `BehaviorContext.collection` 与 `pending.kind='selection'`，跳过 `action.execute`；后续回答只在当前候选集合中解析，非法选择返回固定中文提示。

- [x] **Step 4: Verify ordinary and streaming turns**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/function-collector.test.ts tests/integration/agent-sandbox/pi-bridge.test.ts
git add examples/agent-sandbox/src/function-collector.ts examples/agent-sandbox/src/session-routing.ts examples/agent-sandbox/src/session.ts examples/agent-sandbox/src/session-stream-turn.ts examples/agent-sandbox/src/session-types.ts tests/integration/agent-sandbox/function-collector.test.ts
git commit -m "feat: collect ambiguous functions deterministically"
```

Expected: 普通 turn、stream turn 和 bridge turn 产生同样的 collector 状态、原因码和执行阻断。

### Task 5: Implement the generic parameter collector

**Files:**
- Create: `examples/agent-sandbox/src/parameter-collector.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session-turn.ts`
- Modify: `examples/agent-sandbox/src/session-stream-turn.ts`
- Modify: `examples/agent-sandbox/src/session-clarification.ts`
- Modify: `examples/agent-sandbox/src/session-core.ts`
- Test: `tests/integration/agent-sandbox/parameter-collector.test.ts`

- [x] **Step 1: Write RED tests for missing, invalid and conflict parameters**

使用只含 `target`、`priority`、`enabled` 的合成 Function Schema：首轮缺参必须返回 `parameter_missing`；用户补齐后进入确认或查询执行；非法 enum 返回 `parameter_invalid`；同字段出现两个不同值返回 `parameter_conflict` 且执行次数为零。

- [x] **Step 2: Implement bounded state merge**

`parameter-collector.ts` 只合并 Schema 声明的字段；未知字段丢弃并记录 invalid；旧值和新值不一致时进入 conflict；required、type、enum 和 additionalProperties 校验统一使用 Schema 校验器。

- [x] **Step 3: Implement Chinese deterministic questions**

独立 presentation metadata 映射控件：`string` 输入框、`number` 数字输入、`boolean` 开关、`enum` 中文选项、数组多选、对象分组表单。没有中文 metadata 时使用 Schema 的 `title/description`，不要求用户输入英文字段或枚举值。

- [x] **Step 4: Implement re-extraction gating**

用户补充后固定使用 collector 中的 Function ID 和 Schema；模型只接收当前 Function 的工具定义和待补字段，程序重新合并和校验。仍缺失就继续收集，完整后才离开 collector。

- [x] **Step 5: Implement bounded recovery**

达到 `MAX_UNRESOLVED_STREAK` 或收集轮次上限时清理 collector，返回固定说明；模型超时、Schema 错误和 Provider 失败都返回稳定原因码，不调用 Response Model 伪造成功。

- [x] **Step 6: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/parameter-collector.test.ts tests/integration/agent-sandbox/semantic-routing-recovery.test.ts tests/integration/agent-sandbox/session-helper-contract.test.ts
git add examples/agent-sandbox/src/parameter-collector.ts examples/agent-sandbox/src/session-routing.ts examples/agent-sandbox/src/session-turn.ts examples/agent-sandbox/src/session-stream-turn.ts examples/agent-sandbox/src/session-clarification.ts examples/agent-sandbox/src/session-core.ts tests/integration/agent-sandbox/parameter-collector.test.ts
git commit -m "feat: collect function parameters with schema gates"
```

### Task 6: Make deterministic fallbacks and confirmation gates explicit

**Files:**
- Modify: `examples/agent-sandbox/src/session.ts`
- Modify: `examples/agent-sandbox/src/session-stream-turn.ts`
- Modify: `examples/agent-sandbox/src/session-turn-helpers.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Modify: `examples/agent-sandbox/src/session-types.ts`
- Test: `tests/integration/agent-sandbox/semantic-routing-recovery.test.ts`
- Test: `tests/integration/agent-sandbox/e2e-structured-context.test.ts`

- [x] **Step 1: Write RED tests for every stable stop**

覆盖 `plugin_missing`、`function_missing`、`function_ambiguous`、`parameter_missing`、`parameter_invalid`、`parameter_conflict`、`confirmation_required`、`model_timeout`、`bridge_unavailable`；断言执行次数为零或恰好一次，并断言对应 `nextAction`。

- [x] **Step 2: Remove model-generated execution fallback**

`finishNormalFallback` 只允许 Response Model 处理普通对话或已经验证的上下文问答。路由缺失、参数缺失、Schema 失败、模型失败和桥接失败使用固定中文回复，不把错误原因交给模型自由解释。

- [x] **Step 3: Enforce confirmation scope**

参数完整后创建 Action；高风险动作只能进入 `awaiting_confirmation`。确认使用完整 Action 输入的 scope hash，任何参数变化都使旧确认失效。

- [x] **Step 4: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/semantic-routing-recovery.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts
git add examples/agent-sandbox/src/session.ts examples/agent-sandbox/src/session-stream-turn.ts examples/agent-sandbox/src/session-turn-helpers.ts examples/agent-sandbox/src/session-routing.ts examples/agent-sandbox/src/session-types.ts tests/integration/agent-sandbox/semantic-routing-recovery.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts
git commit -m "fix: fail closed on incomplete route and parameters"
```

### Task 7: Render collection forms, timing, trace and structured context

**Files:**
- Modify: `examples/agent-sandbox/src/session-types.ts`
- Modify: `examples/agent-sandbox/src/http-session-routes.ts`
- Modify: `examples/agent-sandbox/src/http-stream-transport.ts`
- Modify: `examples/agent-sandbox/src/page-template.ts`
- Modify: `examples/agent-sandbox/web/interaction.fragment.js`
- Modify: `examples/agent-sandbox/web/session.fragment.js`
- Modify: `examples/agent-sandbox/web/timing.fragment.js`
- Modify: `examples/agent-sandbox/web/styles.css`
- Test: `tests/integration/agent-sandbox/web-assembly.test.ts`
- Test: `tests/integration/agent-sandbox/e2e-structured-context.test.ts`

- [x] **Step 1: Add RED response-shape tests**

断言澄清结果可携带 collector kind、Function/Plugin ID、中文字段 label、控件类型、选项和 Trace ID；timing 包含总耗时和阶段耗时；复制按钮复制白名单 JSON，不复制 thinking 原文或敏感值。

- [x] **Step 2: Render deterministic collection view models**

把 Function/参数收集状态映射为 UI 可渲染结构，内部 ID 保持机器值，label、description 和 options 使用中文；表单提交仍进入同一个会话 turn，不新增绕过 Schema 的执行 API。

- [x] **Step 3: Render timing, trace and final-model thinking**

在回复卡片和 Timing 区域显示服务端总耗时、阶段耗时、Trace ID、模型角色和稳定结果。流式事件中只允许 `response.generate` 发送 `reasoningDelta`；抽取和路由阶段禁止发送 thinking。正式文本完成后默认收起思考区域。

- [x] **Step 4: Add structured-context copy**

复制内容仅包含 route、Function、Plugin、参数字段状态、阶段耗时、原因码和 Trace ID；不包含原始用户输入、完整 prompt、模型响应、凭据或 thinking 原文。

- [x] **Step 5: Verify and commit**

```bash
npm run build
node scripts/run-tests.mjs tests/integration/agent-sandbox/web-assembly.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts
git add examples/agent-sandbox/src/session-types.ts examples/agent-sandbox/src/http-session-routes.ts examples/agent-sandbox/src/http-stream-transport.ts examples/agent-sandbox/src/page-template.ts examples/agent-sandbox/web/interaction.fragment.js examples/agent-sandbox/web/session.fragment.js examples/agent-sandbox/web/timing.fragment.js examples/agent-sandbox/web/styles.css tests/integration/agent-sandbox/web-assembly.test.ts tests/integration/agent-sandbox/e2e-structured-context.test.ts
git commit -m "feat: expose collection diagnostics and trace timing"
```

### Task 8: OpenSpec, full verification and final audit

**Files:**
- Modify: `openspec/changes/recover-semantic-routing-gaps/tasks.md`
- Modify: `openspec/changes/recover-semantic-routing-gaps/design.md`
- Modify: `openspec/changes/recover-semantic-routing-gaps/proposal.md`
- Review: all files changed by Tasks 1-7

- [x] **Step 1: Update and validate OpenSpec**

补充 Function collector、parameter collector、Schema-driven UI 和 deterministic fallback；删除暗示业务关键词或 Response Model 授权执行的描述。

```bash
openspec validate recover-semantic-routing-gaps --strict
```

- [x] **Step 2: Run the complete verification suite**

```bash
npm run build
npm run lint
node scripts/run-tests.mjs tests/integration/agent-sandbox tests/integration/model-gateway
node scripts/run-tests.mjs
```

- [x] **Step 3: Perform domain reviews**

按 `logging-boundaries` 检查白名单、脱敏、Trace/MDC、日志量和开关；按 `backend-reliability-guidelines` 检查超时、幂等、确认门禁、错误分类和并发状态；按 `code-review-spec` 检查边界、异常路径和测试质量；按前端交互规则检查表单、加载、错误、禁用、键盘和复制行为。

- [x] **Step 4: Perform plan-implementation consistency audit**

逐条核对 Function collector、parameter collector、状态恢复、参数冲突、确定性反问、模型审计、完整日志、Trace/timing、thinking 范围、结构化上下文复制、普通/流式一致性和无业务专用补丁；没有证据的项目保持未完成。

- [x] **Step 5: Archive and report**

完成每项 OpenSpec task 的单独审计后标记完成，执行 archive 流程；最终报告列出完成项、未完成项、验证命令、审查结论和已知限制。按工作流合并已验证任务分支，不执行未授权的 `git push`。

## 接受标准

1. 只有 Function ID 和参数 Schema 同时通过程序校验，才允许创建 Action。
2. Plugin 命中但 Function 不唯一时，出现中文 Function 收集器；唯一 Function 自动绑定。
3. Function 已确定但参数缺失、非法或冲突时，出现中文参数收集器，不要求用户输入英文字段或枚举值。
4. 收集器状态可重启恢复，下一轮只在原 Function 范围内重新抽取和校验。
5. Response Model 的文本、thinking、`confirmed` 字样和“已执行”字样都不能授权执行。
6. 每一轮日志能通过 Trace ID 还原模型 attempt、语义抽取、路由候选、参数边界、确认、执行和最终回复。
7. 模型超时、Provider 失败、Schema 失败、桥接不可用和收集超限都有独立、稳定、中文可读的兜底结果。
8. 普通 turn、stream turn 和 bridge turn 在收集器状态、执行门禁和日志原因上保持一致。
