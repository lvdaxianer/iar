# IAR 五阶段落地设计

## 目标

把 `docs/README.md` 中的 IAR 方案转化为一条可执行、可验收、可逐阶段提交的工程路线。当前仓库只有方案文档，因此本文件只定义落地设计，不实现运行时代码。

## 设计原则

1. 执行链路固定为 `SemanticFrame → FunctionRule → Function Decision → PluginRule → Plugin Decision → Policy → Workflow → Executor`。
2. `Function` 是第一层授权和路由边界；Plugin 必须归属一个 Function，模型不能扩大能力范围。
3. EventLog 是恢复事实源；BehaviorContext、Snapshot 和 ContextView 都是可校验投影。
4. 所有模型输出、插件输入输出、确认结果和持久化状态都必须经过契约校验。
5. Phase 1/2 不依赖真实模型、PostgreSQL、消息队列、容器或 Temporal。
6. 观测订阅默认异步、fail-open；权限和审批 Hook 默认同步、fail-closed。

## 阶段边界

| 阶段 | 交付内容 | 阶段完成证据 | 明确不做 |
| --- | --- | --- | --- |
| Phase 1 | contracts、plugin-host、plugin-sdk、storage、subscriptions、BehaviorContext、replay | fake plugin 可安装/启停/卸载，事件可重放，压缩失败保留旧状态 | 真实模型、API、服务化 |
| Phase 2 | 复合规则、两阶段路由、Mock Decision、Policy、确认、本地 Workflow | “停止第一个服务”恢复 `test1`，未确认不执行，幂等不重复执行 | 外部模型、PostgreSQL、Temporal |
| Phase 3 | ModelGateway、Semantic/JEV Adapter、Fastify API、三个示例插件 | API contract tests、模型脱敏/降级、示例插件端到端测试 | 隔离执行和远程分发 |
| Phase 4 | PostgreSQL、Service/Sidecar、CLI、OpenTelemetry/Pino、Worker/容器 | 多租户隔离、执行器清理、日志脱敏、跨模式契约一致 | Temporal、远程 ABI |
| Phase 5 | durable WorkflowRuntime、远程插件分发、签名、ABI、控制面 | worker 丢失恢复、能力审批、版本回滚、兼容性矩阵 | 把短动作默认迁移到 durable runtime |

## 模块结构

```text
config/
  models.yaml
packages/
  contracts/          # Schema、类型、事件、错误码
  runtime/            # 编排、上下文投影、Policy 入口
  plugin-host/        # 注册、依赖、生命周期
  plugin-sdk/         # Manifest、Handler、开发测试接口
  subscriptions/      # Hook、StateEvent、Dispatcher
  rule-engine/        # Function/Plugin 规则与候选集
  decision/           # Mock、Semantic、JEV、ModelGateway
  workflow/           # 本地状态机、重试、恢复、幂等
  storage/            # Event/Snapshot/Registry Store
  adapters/           # Fastify、PostgreSQL、Sidecar、Temporal、Executor
  observability/      # Trace、Metric、Structured Log、Audit
  cli/                # install、enable、disable、inspect、replay
examples/             # knowledge-query、ticket-create、human-transfer
tests/                # contract、replay、routing、workflow、security、integration
```

## 关键不变量

- Plugin 不能脱离其 `functionId` 被选中。
- `needs_clarification`、拒绝、权限失败和确认缺失都不能启动副作用。
- 压缩不能改变 `subject`、`action`、Function、Plugin、slots、workflow step、pending、confirmation 和 idempotency key。
- 相同事件序列必须投影出相同状态；相同幂等键不能产生第二次外部副作用。
- 卸载只撤销当前注册，不删除历史事件；执行中 Workflow 按固定版本或 `plugin_unavailable` 策略继续。
- 原始 Prompt、原始用户输入、API Key、Authorization 和敏感槽位默认不进入日志或宿主响应。

## 计划产物

- OpenSpec change：`openspec/changes/iar-five-phase-roadmap/`
- OpenSpec 规格：5 个 capability spec，覆盖契约、状态、路由、策略/API、服务化/持久工作流。
- OpenSpec 任务：按 Phase 1～5 排序，包含依赖、允许文件、验证命令和交接证据。
- 执行计划：[`docs/superpowers/plans/2026-10-16-iar-five-phase-roadmap.md`](../plans/2026-10-16-iar-five-phase-roadmap.md)

## 计划阶段的验收

本次计划交付不声称任何运行时代码已完成。计划文件必须通过 `openspec validate iar-five-phase-roadmap --strict`，任务清单必须覆盖文档中 7 条验收标准，并明确每一阶段的测试与回滚证据。

| 原方案验收标准 | 计划落点 |
| --- | --- |
| 序号引用后停止第一个服务并恢复 `test1` | Phase 2 Task 2.5 / `tests/replay/stop-first-service` |
| 混合候选先限 Function，再由 JEV 类型化选择或澄清 | Phase 2 Tasks 2.1–2.3；Phase 3 Task 3.2 |
| Plugin 候选仅来自已启用且已授权的当前 Function | Phase 2 Task 2.3；Phase 4 Task 4.1 |
| 未确认或未授权不能进入副作用执行 | Phase 2 Task 2.4；Phase 3 Task 3.3 |
| 压缩后关键行为状态可恢复 | Phase 1 Tasks 1.4–1.6 |
| 重启可重放且幂等键不重复副作用 | Phase 1 Task 1.4；Phase 2 Task 2.4；Phase 5 Task 5.2 |
| 卸载撤销当前注册但保留历史并支持回滚 | Phase 1 Task 1.3；Phase 4 Task 4.5；Phase 5 Task 5.3 |
