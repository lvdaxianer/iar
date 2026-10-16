# Phase 2 Task 2.4 实现审计

## 结论

Task 2.4 已完成本地确定性 Workflow、Policy Gate、confirmation scope hash、retry/timeout/cancel/resume 和 Action 幂等执行边界。实现只覆盖内存状态与确定性 executor 门禁，没有提前引入真实模型、数据库、远程插件或 durable worker。

## 范围与边界

- 模块：`packages/workflow/`。
- 覆盖：显式状态机、运行时输入校验、授权/能力/confirmation 门禁、Action identity、幂等结果重放、executor 异常和 Schema 校验、ledger 后状态竞态补偿。
- 必要配套：`packages/runtime/package.json` 的类型入口和 workspace lockfile 记录，保证 workflow 复用 `ActionIdempotencyLedger`。
- 测试：`tests/workflow/local-workflow.test.ts` 与 `tests/workflow/workflow-edge-cases.test.ts`。
- 非目标：真实 HTTP API、Fastify、PostgreSQL、Temporal、真实插件执行、跨进程持久化和外部模型。

## 验收映射

| OpenSpec 要求 | 实现/测试证据 |
| --- | --- |
| 显式 Workflow 状态转移和终态保护 | `LocalWorkflow.transition`；未知事件、waiting、终态和重复 transition 测试 |
| Policy Gate 在 Action executor 前执行 | `ActionExecutionService.preflight`；未授权、缺能力、未确认和 malformed policy 测试 |
| confirmation 绑定完整 Action scope | `confirmationScopeHash` 对 actionId、runId、functionId、pluginId、idempotencyKey、input、riskLevel 和 confirmationRequired 做 canonical sha256 |
| retry/timeout/cancel/resume 语义稳定 | `LocalWorkflow.fail/retry/timeout/cancel/resume`；waiting、终态和竞态测试 |
| Action 幂等和身份冲突 fail-closed | runtime `ActionIdempotencyLedger` 加本地 Action identity/result map；重复结果、相同 key 不同 Action 和 malformed executor 测试 |
| ledger 后状态竞态不调用 executor | `recordStateRace`；cancel/timeout 竞态测试断言 executor 次数为零并保留终态错误码 |
| executor 结果仍经过公共 Schema | `callExecutor`；非法 Schema、错误 actionId 和异常测试 |

## TDD 与验证证据

- RED：安装 workspace 依赖后首次执行 `npm test -- --run tests/workflow`，因缺少 `packages/workflow/src/index.js` 导出而失败。
- GREEN：实现后 focused workflow 测试由 12/12 增长并最终稳定为 `16/16`。
- broader verification：`npm run lint`、`npm run build`、`npm test` 全部通过。
- 全量结果：`109/109` 通过。
- package verification：`import('@iar/workflow')` 与 `import('@iar/runtime')` 根入口均成功。
- 结构检查：`git diff --check` 通过；所有新增/修改源文件和测试文件均不超过 350 行，测试注释比例满足 canonical 下限。
- 计划一致性：`phase-2-task-2.4-plan.md` 明确记录 workflow/runtime lockfile 与 runtime 类型入口属于本任务必要配套。
- OpenSpec：完成前执行 `openspec validate iar-five-phase-roadmap --strict`。

## Review 与修复记录

同一 code-review agent 多轮审查后最终结论为 `PASS`，无剩余 MUST/SHOULD。修复项包括：

- start/get 返回深拷贝，避免外部修改内部 Workflow 状态。
- 补齐 malformed Action、Policy、executor、retryable、transition 和 failure 输入的 fail-closed 校验。
- 将 replay 放在当前 run、Policy、能力和 confirmation 校验之后，避免已完成结果绕过授权。
- 用完整 Action identity 区分相同 idempotencyKey 的冲突，并保存 ActionResult 供稳定重放。
- executor 异常、非法结果和 ledger 状态竞态均固化为可解释的稳定结果，且不发生额外副作用。
- 增加 duplicate replay、非法 executor、非法结果、重复 transition、cancel/timeout 竞态回归测试。

## 领域审查

- Backend reliability：Policy、confirmation、idempotency、状态和 executor 采用固定顺序；任何 malformed、未授权、缺能力、未确认、终态或竞态输入均 fail-closed。
- 权限边界：duplicate replay 也重新验证当前授权、能力和 confirmation；executor 只能收到已通过门禁的 Action 深拷贝。
- 副作用边界：ledger 预占后若 Workflow 已 cancel/timeout，则补偿为稳定失败并保持 executor 调用次数为零。
- 可审计性：Action identity、scope hash、reasonCode、lastError 和终态状态均可从本地快照解释。

## 交接

Task 2.4 为 Task 2.5 提供本地 Workflow、Policy/confirmation 和 Action 幂等语义；后续 API 层应只映射稳定结果，不绕过本地门禁。
