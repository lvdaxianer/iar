# Canonical Function ID Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `openspec-apply-change` and `test-driven-development` to implement this plan task-by-task. Each task must pass its focused test, review, audit and commit gate before the next task begins.

**Goal:** 让模型返回稳定的 `plugin_id/function_id/operation`，由程序固定校验并安全执行，避免自然语言意图导致合法路由误判和额外兜底模型调用。

**Architecture:** 保留 Plugin-first 的嵌套 OpenAI-compatible tool 边界。模型只从当前启用且授权的 Plugin 工具中提出规范 ID 和命名参数；运行时通过 PluginHost、已安装 Schema、授权、Policy、确认和幂等性重新验证。查询结果进入 Response Model 汇总，动作确认和 direct/none 结果按既有 response contract 分流。

**Tech Stack:** TypeScript、Node.js、OpenAI-compatible Function Calling、PluginHost、RuleEngine、JEV/Intent Model Decision Adapter、Node test runner、OpenSpec。

---

## 文件地图

- `packages/runtime/src/routing.ts`：嵌套路由、规范身份评估、拒绝证据和最终执行门禁。
- `packages/runtime/src/intent/decision/model-gateway/function-call.ts`：嵌套工具调用的版本化解析、有限候选和参数对象校验。
- `examples/agent-sandbox/src/models/model-input-transport.ts`：模型输入契约和规范 ID 提示词。
- `examples/agent-sandbox/src/session-routing.ts`：Sandbox 规则构造，避免把自然语言标签当作稳定所有权键。
- `tests/routing/`：规范 ID、Plugin 所有权、参数和门禁回归测试。
- `tests/integration/agent-sandbox/`：真实会话、确认、查询回复和兜底分流测试。
- `openspec/changes/canonical-function-id-routing/`：本变更的提案、设计、规格增量和任务清单。

## Task 1：固化规范 ID 输出契约

### Step 1：添加失败测试

- [ ] 在现有嵌套 Function Calling 测试中加入自然语言 `semantic.intent = "创建工单"`、模型返回 `function_id = "ticket.create"` 的用例。
- [ ] 断言测试输入包含 `plugin_id`、`function_id`、`operation` 和命名 `arguments`，且自然语言字段不参与 Function 所有权判断。

### Step 2：确认 RED

运行：

```bash
npm run build
node --test dist/tests/routing/nested-plugin-function-routing.test.js
```

预期：新增用例在修复前因 `plugin_rule_not_matched` 失败。

### Step 3：实现最小契约修复

- 要求嵌套模型输出当前工具集合中的规范 ID。
- 使用 OpenAI-compatible 工具参数对象承载 Function 参数。
- 未知 Plugin、Function、Operation、非对象参数和多余字段统一返回稳定拒绝，不进入执行器。

### Step 4：确认 GREEN

运行同一 focused test，预期新增和既有测试全部通过。

## Task 2：修复运行时身份和规则匹配

### Step 1：添加失败测试

- 构造原始事实 `semantic.intent = "创建工单"`。
- 构造嵌套提议 `plugin_id = "ticket-support-v1"`、`function_id = "ticket.create"`、`operation = "create"`。
- 构造规则要求规范 Function ID。
- 断言路由成功进入确认或执行路径，不触发 `plugin_rule_not_matched`。

### Step 2：确认 RED

运行对应路由测试，预期当前实现仍使用自然语言 `semantic.intent` 评估规则并失败。

### Step 3：实现最小运行时修复

- 在 `routeNestedProposalAsync` 中使用已解析的规范身份建立本次插件规则评估视图。
- 该视图只用于规则评估，不改变原始会话事实。
- 继续执行 PluginHost 当前注册状态、授权、能力、Policy、确认、幂等和 Schema 校验。
- 让拒绝结果保留 `pluginId/functionId/operation/reasonCode`。

### Step 4：确认 GREEN

运行路由 focused test、Function Calling focused test 和 Sandbox 集成测试，预期合法 `ticket.create` 不再误判。

## Task 3：完善回复和错误分流

### Step 1：添加失败测试

覆盖以下输入和预期：

- 查询 Function 成功：结果调用 `response.generate`。
- 高风险动作：等待确认，不调用不必要的回复模型。
- `direct/none`：不调用回复模型。
- 未知 ID、关闭 Plugin、权限失败、参数错误、模型超时和桥接不可用：进入对应稳定错误或澄清。

### Step 2：实现分流

- 合法路由不能因为规则字段不一致而进入兜底模型。
- 兜底只处理无合法规范 ID、信息不足、能力不可用和基础设施失败。
- UI 和日志显示明确错误类型，不把所有情况归类为“错误”。

### Step 3：验证

运行：

```bash
npm run lint
npm run build
node --test dist/tests/integration/agent-sandbox/response-observability.test.js
```

## Task 4：性能与最终验证

### Step 1：建立模型实测基线

使用同一输入重复测试至少 10 次，记录：

```text
semantic.extract
route.propose / function.select
action.execute
response.generate
total
```

分别计算 P50、P95、超时数和路由成功率。

### Step 2：确认错误路径优化

验证合法 `ticket.create` 请求不再额外触发错误兜底 `response.generate`，并确认总耗时下降。若仍超过 2.5 秒，再单独评估合并模型调用，不能牺牲准确率和安全门禁。

### Step 3：全量验证

运行：

```bash
openspec validate canonical-function-id-routing --strict
git diff --check
npm run lint
npm run build
npm test
```

### Step 4：完成审计和提交

- 检查模型输出是否始终受有限工具集合约束。
- 检查自然语言字段没有重新成为程序所有权判断键。
- 检查 Plugin 关闭、授权失败和参数错误均 fail-closed。
- 检查日志和 Timing 只输出安全摘要、耗时和 Trace ID。
- 通过 code review、per-task audit 后按中文 Conventional Commit 提交。
- 将任务分支合并回 `master`，确认 `master` 包含变更后清理 worktree。

## 验收标准

- “帮我创建一张工单，描述是会议室投影仪连不上，紧急程度高” 能返回 `ticket.create` 规范身份。
- 程序只使用规范 ID、注册关系和 Schema 判断是否可执行。
- 参数字段不会按位置错位，未知或错位参数不会执行。
- 查询 Function 结果经过 Response Model 汇总。
- 动作 Function 仍经过确认、授权、Policy 和幂等门禁。
- 无合法 ID 时才进入澄清或兜底回答。
- UI 能显示真实 Plugin、Function、Operation、失败类型、总耗时和 Trace ID。
- 全量测试、OpenSpec 严格校验和性能基线均有可复现证据。
