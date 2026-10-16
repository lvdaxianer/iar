# Phase 2 Task 2.6 实现审计

## 结论

Task 2.6 已完成 Phase 2 集成验证，并为本地 Workflow 增加可注入的 `WorkflowEventLog`。成功、Policy/confirmation 拒绝、executor 异常、重复 Action 和合法状态拒绝均产生版本化可回放事件；malformed Action、未知 run 和 run mismatch 不伪造事件历史。

## 范围与边界

- 模块：`packages/workflow/src/event-log.ts`，以及 `LocalWorkflow`/`ActionExecutionService` 的事件接入。
- 事件：`workflow.started`、`workflow.transitioned`、`action.started`、`action.completed`、`action.failed`。
- runtime 安全边界：公开事件入口重新校验 Action/ActionResult；拒绝事件只在已存在且 Action/run 归属匹配时写入。
- 回放验证：`tests/workflow/event-replay.integration.test.ts` 使用固定 clock，调用 `replayEvents` 验证最终 Action 状态。
- 非目标：PostgreSQL、Temporal、HTTP API、外部模型、真实插件 executor 和跨进程 durable EventStore。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| Action 结果都有明确事件 | `WorkflowEventLog.actionStarted/actionCompleted/actionFailed`；成功和 executor 异常测试 |
| 拒绝路径 fail-closed 且可审计 | Policy/confirmation 拒绝、duplicate、非法结果、waiting/terminal 语义复用 Task 2.4；合法 Action rejection 记录 `action.failed` |
| 未知/错配上下文不伪造事件 | `ActionExecutionService.reject` 只接受已存在 run 和匹配 `action.runId`；专门回归测试断言零 Action 事件 |
| EventEnvelope 可重放 | sink 对事件调用公共 event Schema 校验；固定事件链由 `replayEvents` 投影为最终 `action.status` |
| 事件顺序稳定 | 集成测试断言 `action.failed → action.started → action.completed` 的完整顺序和 duplicate 追加结果 |
| malformed 输入不写事实 | EventLog 公开入口 runtime 校验 Action/ActionResult，非法输入抛错且事件数量保持不变 |

## TDD 与验证证据

- RED：新增集成测试首先因缺少 `WorkflowEventLog` 导出、`LocalWorkflowOptions.eventLog` 和事件类型边界而在 build 阶段失败。
- GREEN：接入 event sink 后集成测试 `2/2` 通过。
- focused：`npm test -- --run tests/workflow tests/replay`，最终 `44/44` 通过。
- broader verification：`npm run lint`、`npm run build`、`npm test`，全量 `115/115` 通过。
- package verification：`@iar/workflow` 与 `@iar/runtime` 包根入口导入成功。
- 结构检查：新增/修改源文件均不超过 350 行；集成测试注释比例 40.7%；tracked/untracked `git diff --check` 通过。
- 计划一致性：`phase-2-task-2.6-plan.md` 记录事件 sink 边界、拒绝规则、TDD 命令和交接证据。
- OpenSpec：完成前执行 `openspec validate iar-five-phase-roadmap --strict`。

## Review 与修复记录

同一 code-review agent 最终复核结论为 `PASS`，无 MUST/SHOULD。修复项包括：

- 为 WorkflowEventLog 的公开 Action 入口补充 Action/ActionResult runtime Schema 校验。
- 禁止 `workflow_not_found` 和 `action_run_mismatch` 在未知或错配上下文中写入伪造 Action 事件。
- 补充 malformed 输入无事件、事件顺序和未知/错配 run 无历史的回归测试。
- 补齐公共入口注释、分支说明、JSDoc、文件行数和测试注释比例约束。

## 领域审查

- Backend reliability：事件写入位于 Policy、幂等和 executor 边界内；事件回放只更新投影，不执行外部副作用。
- 权限边界：拒绝事件只来自已确认的 Workflow/Action 归属；provider 或 malformed 输入不能伪造合法 Action 事实。
- 可审计性：事件 payload 保留 actionId、functionId、pluginId、idempotencyKey、input 摘要、result/error/reasonCode 和状态顺序。
- 适配边界：当前 sink 是本地内存实现，后续 durable EventStore 可复用同一 EventEnvelope 语义而不改本地 Workflow 行为。

## 交接

Phase 2 的所有任务已完成。后续 Phase 3 API/Model adapter 应复用 `WorkflowEventLog` 的事件分类和 `replayEvents` 语义，不绕过 Policy Gate、Action 幂等或 EventLog。
