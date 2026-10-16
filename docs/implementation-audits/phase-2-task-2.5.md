# Phase 2 Task 2.5 实现审计

## 结论

Task 2.5 已完成 `test1` DIP stop-service 的路由、确认、单次执行和 EventLog 回放验收夹具。测试直接复用生产的 `TwoStageRouter`、`PluginHost`、`LocalWorkflow`、`ActionIdempotencyLedger` 和 `replayEvents`，没有复制路由或 Workflow 逻辑。

## 范围与边界

- 路由夹具：`tests/routing/phase-2-stop-service-fixture.ts` 与对应 routing test。
- Workflow 验收：确认前返回 `confirmation_required` 且 executor 零调用；确认后执行 `test1` 一次，重复提交返回 `action_duplicate`。
- Replay 夹具：`tests/replay/fixtures/phase-2-stop-service.json`，记录三个 DIP 服务、Function/Plugin route、waiting/confirmed 状态和 Action completed 事实。
- Replay 测试：两次 `replayEvents` 结果一致，并校验 subject、route、workflow、confirmation、idempotency、Action status 和 critical hash。
- 非目标：真实 DIP API、HTTP API、模型、数据库、Temporal、远程插件和真实副作用。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| 列出三个 DIP 服务后恢复首个 `test1` | `DIP_SERVICES = ['test1', 'test2', 'test3']`；routing/workflow/replay 三处均断言 `test1` |
| 先选 `dip.service.stop` 再选已授权插件 | routing test 断言 Function provider 的 `function.select` 先于 Plugin provider 的 `plugin.select`，最终为 `dip-api-stop-v1` |
| 高风险动作确认前不执行 | workflow test 断言 `confirmation_required` 和 `calls === 0` |
| 确认后只执行一次 | workflow test 断言首次 `succeeded`、重复 `action_duplicate` 和 `calls === 1` |
| 路由与执行事实可回放 | JSON fixture 记录 `workflow.started`、`decision.created`、两个 `workflow.transitioned`、`action.started`、`action.completed`；replay test 校验确定性结果 |

## TDD 与验证证据

- RED 1：首次执行 focused command 时，测试夹具出现 `RuleEvaluationFacts` unknown spread 和 `JsonValue` output 类型错误。
- RED 2：修复测试类型边界后，回放测试因缺少 `phase-2-stop-service.json` 返回 `ENOENT`。
- GREEN：补入六事件 JSON fixture 后，新增 focused 集成测试 `3/3` 通过。
- Phase 2 focused：`npm test -- --run tests/routing tests/workflow tests/replay`，`74/74` 通过。
- broader verification：`npm run lint`、`npm run build`、`npm test`，全量 `112/112` 通过。
- package verification：`@iar/runtime` 和 `@iar/workflow` 包根入口导入成功。
- 结构检查：新增 TS 文件均不超过 350 行、注释比例达到 canonical 下限，`git diff --check` 通过。
- 计划一致性：`phase-2-task-2.5-plan.md` 记录了允许文件、排除范围、依赖、TDD 命令和交接证据。
- OpenSpec：完成前执行 `openspec validate iar-five-phase-roadmap --strict`。

## Review 与修复记录

同一 code-review agent 最终复核结论为 `PASS`，无 MUST/SHOULD。审查确认：

- 测试调用生产边界，没有复制 `TwoStageRouter`、`LocalWorkflow` 或 replay 实现。
- 三个 DIP 服务、Function → Plugin 顺序、授权插件、确认前零调用、确认后单次执行和 duplicate replay 均有断言。
- Replay fixture 的事件顺序、runId、时间、scope hash 和 critical hash 均可确定性解释。
- 所有新增 TS 文件满足行数与注释比例约束，fixture、计划文件和 diff hygiene 正常。

## 领域审查

- Backend reliability：路由选择与 Action 执行分层；未确认路径不进入 executor，重复 Action 复用 Task 2.4 的幂等结果语义。
- 权限边界：PluginHost 当前 enabled Manifest 提供 `dip.service.write`，provider 只能从有限候选返回选择。
- 回放边界：EventLog 只重建 BehaviorContext，不调用 executor；route、confirmation、idempotency 和 Action status 作为事实被保留。

## 交接

Task 2.5 为 Task 2.6 提供可执行的 Phase 2 集成回放基线；后续集成验证应继续使用该 fixture，并确认所有 Action 结果/拒绝路径写入可重放事件。
