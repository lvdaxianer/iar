# Tasks

## 1. 固化规范 ID 输出契约

- [x] 1.1 在 `packages/runtime/src/intent/decision/model-gateway/function-call.ts` 和 `examples/agent-sandbox/src/models/model-input-transport.ts` 明确嵌套工具只能返回当前有限集合中的 `plugin_id`、`function_id`、`operation` 和命名 `arguments`；补充 `tests/integration/model-gateway/function-call-routing.test.ts` 的非法、未知和非对象参数测试。
- [x] 1.2 验证模型层、JEV/Intent Model 层和普通路由层都不会把自然语言 `semantic.intent` 当作规范 Function ID；保留自然语言字段作为上下文和日志摘要。

## 2. 修复运行时身份校验

- [x] 2.1 在 `packages/runtime/src/routing.ts` 为 `routeNestedProposalAsync` 增加规范身份视图，只在插件规则评估中使用已校验的 `plugin_id/function_id`，不回写原始事实。
- [x] 2.2 保留 Plugin 所有权、启用状态、授权、能力、Policy、确认、幂等性和输入 Schema 门禁；验证模型只能提出调用，不能授予执行权限。
- [x] 2.3 修改拒绝结果构造，使 `pluginId`、`functionId`、`operation` 和稳定 `reasonCode` 在 UI/日志证据中保持一致。

## 3. 明确回复与兜底分流

- [x] 3.1 验证合法查询 Function 的有界结果进入 `response.generate`，动作确认和 `direct/none` 结果不触发不必要的回复模型。
- [x] 3.2 验证只有无合法 ID、信息不足、Plugin 关闭、模型超时、桥接不可用或程序校验失败时才进入澄清/兜底回答。
- [x] 3.3 为错误分类补充安全提示，区分 `plugin_unavailable`、`function_unknown`、`operation_unknown`、`validation_failed`、`authorization_denied`、`model_timeout` 和 `bridge_unavailable`。

## 4. 回归测试与性能证据

- [x] 4.1 在路由回归测试中覆盖自然语言语义与规范 Function ID 分离，验证模型提案可以落到目标 Function。
- [x] 4.2 添加参数字段错位、未知 ID、重复 Function ID、关闭 Plugin、高风险确认和查询汇总测试，覆盖路由、Function Calling 和 Agent Sandbox 回复分流。
- [x] 4.3 运行真实模型基线测试并记录 `semantic.extract`、路由提议、执行、`response.generate` 和总耗时的 P50/P95；确认误路由不再触发额外回复模型。
- [x] 4.4 运行 `openspec validate canonical-function-id-routing --strict`、`npm run lint`、`npm run build` 和 `npm test`，记录结果并完成代码审查。
- [x] 4.5 修正沙箱决策后端自动选择：JEV 三项配置不完整时只使用 Intent Model，显式选择未配置的 JEV 时 fail-fast，并补充配置隔离回归测试。
- [x] 4.6 将已配置的 JEV profile 绑定到真实 JEV provider：仅在 JEV 三项连接配置完整时调用 JEV endpoint；未配置 JEV 时继续只调用 Intent Model，不得静默使用本地 mock provider。

> 4.3 的代码侧本地基准已覆盖 1/5/10/20/40 个 Plugin、请求体规模、TTFB、总耗时和 20 次命名参数稳定性；真实模型基线见 `docs/performance/2026-10-22-real-model-baseline.md`。

## Workflow follow-up

- 所有实现任务通过 per-task audit、验证和提交后，将任务分支合并回 `master`。
- 完成最终审计后归档本 OpenSpec change，并删除专用 worktree。
