# Tasks

## 1. Phase 1 — 契约与嵌入式基础

**Task boundary and dispatch plan**

- Module agent: `contracts-state-foundation`。
- Owned responsibility: workspace scaffold, public contracts, Manifest/Registry lifecycle, EventLog/Snapshot/BehaviorContext, subscriptions and Phase 1 tests。
- Allowed files/modules: `.editorconfig`、`.gitattributes`、`.gitignore`、`.npmrc`、`package.json`、`package-lock.json`、`tsconfig*.json`、`scripts/**`、`packages/contracts/**`、`packages/plugin-sdk/**`、`packages/plugin-host/**`、`packages/storage/**`、`packages/subscriptions/**`、`packages/runtime/**`、`tests/contract/**`、`tests/replay/**`、对应 `docs/**`。
- Out of scope: real LLM/JEV、Fastify API、PostgreSQL、Worker/container、Temporal、业务示例插件。
- Dependencies: current docs baseline and `runtime-contracts`/`behavior-state` specs。
- Focused verification: `npm test -- --run tests/contract tests/replay`。
- Broader verification: `npm run lint && npm run build && npm test`。
- Handoff evidence: package tree、schema/fixture 清单、测试输出、EventLog replay 样例和未解决风险记录。

- [x] 1.1 创建 npm workspace、TypeScript 编译配置、包目录和测试命令；验证 `npm install`、`npm run build` 与空测试基线成功，且构建产物未进入版本控制。
- [x] 1.2 在 `packages/contracts/` 定义 `Function`、`PluginManifest`、`Rule`、`Workflow`、`Action`、`Decision`、`BehaviorContext`、事件和错误码的版本化 Schema/类型；验证合法 fixture 通过、缺少必填字段和版本不兼容 fixture 被拒绝。
- [x] 1.3 在 `packages/plugin-sdk/` 与 `packages/plugin-host/` 实现 Manifest 校验、Function 归属、依赖排序、注册表和 discovered → validated → installed → enabled → draining/disabled → unloaded 生命周期；验证错误安装不改变注册表，卸载撤销当前能力但保留事件。
- [x] 1.4 在 `packages/storage/` 实现 EventStore、SnapshotStore、RegistryStore 接口及内存/SQLite 适配器；在 `packages/runtime/` 实现 BehaviorContext 投影、关键字段哈希和事件重放；验证相同事件序列得到相同状态，重复幂等键不产生第二次 Action。
- [x] 1.5 实现 `packages/subscriptions/` 的内部 before Hook 与异步 StateEvent 订阅调度，包含优先级、过滤、超时、重试、失败策略、递归深度和订阅幂等键；验证 fail-open observer 不阻断主流程、fail-closed permission handler 能阻断动作。
- [x] 1.6 实现上下文压缩候选结果的 Schema、事件引用、工作流、确认状态和关键哈希校验；验证压缩改变 `subject`、`pluginId`、`currentStep` 或确认范围时保留旧视图并写入 `context.compaction_failed`。
- [x] 1.7 完成 Phase 1 契约/replay 测试和文档样例同步；验证 `npm run lint && npm run build && npm test` 全部通过，并交付可安装、启停、卸载、重放的 fake plugin 演示。

## 2. Phase 2 — 受限路由与本地执行

**Task boundary and dispatch plan**

- Module agent: `bounded-routing-workflow`。
- Owned responsibility: FunctionRule/PluginRule、两阶段决策、Policy Gate、确认、幂等、重试、恢复和核心 Orchestrator。
- Allowed files/modules: `packages/rule-engine/**`、`packages/decision/**`、`packages/workflow/**`、`packages/runtime/**` 中路由/执行扩展、`tests/routing/**`、`tests/workflow/**`、`tests/replay/**`。
- Out of scope: 外部模型 Provider、Fastify、PostgreSQL、Sidecar、真实业务插件和 Temporal。
- Dependencies: Phase 1 contracts、storage、subscriptions、behavior projection。
- Focused verification: `npm test -- --run tests/routing tests/workflow`。
- Broader verification: `npm run lint && npm run build && npm test`。
- Handoff evidence: 路由决策 fixture、候选/排除证据、Policy/Workflow 状态图、`test1` 验收回放和幂等测试报告。

- [x] 2.1 在 `packages/rule-engine/` 实现 FunctionRule/PluginRule、`ALL`/`ANY`/`NONE`、未知字段策略、优先级/特异性冲突处理，并记录匹配和排除证据；验证冲突进入 `needs_clarification` 而不是静默覆盖。
- [x] 2.2 在 `packages/decision/` 实现 Mock DecisionProvider 和统一 choice/score/rejection/noul 结果校验；验证低于阈值、候选为空、候选不可区分时不返回可执行选择。
- [x] 2.3 在 `packages/runtime/` 串联 SemanticFrame → Function 候选/决策 → Plugin 候选/决策，并再次校验 Function 归属、启用状态、租户、环境和能力；验证 Plugin 决策不能增加 capability 或绕过 disabled 过滤。
- [x] 2.4 在 `packages/workflow/` 实现本地确定性状态机、Policy Gate、确认范围/hash、retryable 错误分类、超时、取消、resume 和 Action 幂等；验证高风险动作未确认/未授权时不调用 executor。
- [x] 2.5 添加 `tests/routing/`、`tests/workflow/` 和 replay fixture；验证“列出三个 DIP 服务后停止第一个服务”恢复 `test1`，先选 `dip.service.stop` 再选已授权插件，并在确认后只执行一次。
- [x] 2.6 完成 Phase 2 集成验证；验证 `npm run lint && npm run build && npm test` 通过，所有 Action 结果和拒绝路径均产生可重放事件。

## 3. Phase 3 — 模型适配、API 与示例插件

**Task boundary and dispatch plan**

- Module agent: `model-api-examples`。
- Owned responsibility: ModelGateway、模型角色配置、Semantic Extractor/JEV Adapter、Fastify API 和三类示例插件。
- Allowed files/modules: `config/models.yaml`、`packages/decision/**` 中 provider adapter、`packages/adapters/fastify/**`、`examples/knowledge-query/**`、`examples/ticket-create/**`、`examples/human-transfer/**`、`tests/contract/**`、`tests/integration/**`。
- Out of scope: 改变 Phase 2 路由/策略语义、PostgreSQL、Worker/container、Temporal 和远程插件分发。
- Dependencies: Phase 2 runtime、decision contracts、workflow API、project `.env.example`。
- Focused verification: `npm test -- --run tests/integration/model-gateway tests/integration/fastify`。
- Broader verification: `npm run lint && npm run build && npm test`。
- Handoff evidence: 脱敏请求 fixture、Mock/故障 Provider 测试、API contract test、三个示例插件 manifest 和端到端 run transcript。

- [x] 3.1 在 `config/models.yaml` 和 `packages/decision/` 建立 `ModelProfile`、role 配置、timeout/retry/fallback、structured output、请求脱敏和 profile/model 版本审计；验证 API key、raw prompt 和 raw user input 不进入模型请求日志。
- [x] 3.2 实现 `ModelGateway` 的 Semantic Extractor、JEV Function Decision、JEV Plugin Decision、Context Compactor 和 Response Generator 适配器；验证 Provider 超时、Schema 错误、阈值拒绝和 fallback 都映射为稳定错误/事件。
- [x] 3.3 在 `packages/adapters/fastify/` 提供创建 run、提交 input、提交 confirm、查询 run、install/enable/disable plugin API；验证所有响应包含 trace/run/version/error 字段且不会暴露内部 Prompt、密钥或完整敏感上下文。
- [x] 3.4 实现 `examples/knowledge-query/`、`examples/ticket-create/`、`examples/human-transfer/` 三个 contract-tested 插件；验证每个插件只属于一个 Function，输入/输出 Schema、能力和确认策略与 manifest 一致。
- [x] 3.5 添加 Mock Provider、API contract、插件 contract 和示例端到端测试；验证真实 Provider 不可用时 Mock/安全错误路径仍能完成本地确定性测试。
- [x] 3.6 完成 Phase 3 broader verification；验证 `npm run lint && npm run build && npm test` 通过，并记录 API 兼容性和模型 profile 版本策略。

## 4. Phase 4 — 服务化、隔离执行与观测

**Task boundary and dispatch plan**

- Module agent: `service-isolation-observability`。
- Owned responsibility: PostgreSQL/Service、Sidecar、CLI、OpenTelemetry/Pino、tenant isolation 和 Worker/Sidecar/container executor。
- Allowed files/modules: `packages/adapters/postgres/**`、`packages/adapters/sidecar/**`、`packages/adapters/service/**`、`packages/adapters/executors/**`、`packages/cli/**`、`packages/built-in-plugins/**`、`packages/observability/**`、`tests/security/**`、`tests/integration/service/**`。
- Out of scope: Temporal durable workflow、远程插件目录、跨语言 ABI、未被测试证明需要的消息队列。
- Dependencies: Phase 3 API/contracts and Phase 1 storage/subscription interfaces。
- Focused verification: `npm test -- --run tests/security tests/integration/service`。
- Broader verification: `npm run lint && npm run build && npm test` plus adapter integration tests against disposable local services。
- Handoff evidence: tenant isolation matrix、executor cleanup test、redaction snapshot、CLI transcript、Embedded/Service contract comparison。

- [x] 4.1 实现 PostgreSQL-backed EventStore/SnapshotStore/RegistryStore 和 Service adapter；验证同一 contract test 在 SQLite 与 PostgreSQL 适配器上通过，并且租户不可读取或选择其他租户的 registry/event。
- [ ] 4.2 实现 Sidecar transport、Service API 和 `packages/cli/` 的 install/enable/disable/inspect/replay 命令；验证 Embedded、Sidecar、Service 对同一 deterministic fixture 返回等价状态和错误。
- [ ] 4.3 实现 Worker/Sidecar/container PluginExecutor 的能力范围、超时、取消、资源限制、凭据隔离、版本固定和清理逻辑；验证不可信插件超时/卸载后不保留 active subscription。
- [ ] 4.4 实现 `packages/observability/` 与 system logging plugin 的 trace/metric/structured-log/audit 字段、敏感字段脱敏和 fail-open observer 策略；验证 API key、authorization、rawPrompt、rawUserInput 不出现在日志快照。
- [ ] 4.5 添加租户授权、能力扩展审批、插件升级回滚、服务部署和隔离执行的 security/integration tests；验证 `npm run lint && npm run build && npm test` 及 disposable service tests 全部通过。

## 5. Phase 5 — 持久工作流与远程扩展

**Task boundary and dispatch plan**

- Module agent: `durable-remote-extensions`。
- Owned responsibility: Temporal-compatible WorkflowRuntime adapter、远程插件分发/签名、跨语言 ABI、多租户控制面和升级回滚。
- Allowed files/modules: `packages/adapters/temporal/**`、`packages/plugin-distribution/**`、`packages/abi/**`、`packages/control-plane/**`、`tests/durable/**`、`tests/distribution/**`、`tests/compatibility/**`。
- Out of scope: 改写本地 Workflow 语义、删除 EventLog、绕过 Policy Gate、默认把所有短动作迁移到 Temporal。
- Dependencies: Phase 4 service/isolation/observability evidence and a documented long-running/cross-service requirement。
- Focused verification: `npm test -- --run tests/durable tests/distribution tests/compatibility`。
- Broader verification: `npm run lint && npm run build && npm test` plus failure/restart integration tests。
- Handoff evidence: durable resume trace、签名/回滚报告、ABI compatibility matrix、control-plane audit events、迁移/回滚记录。

- [ ] 5.1 建立长流程准入门槛和 `WorkflowRuntime` adapter contract；验证短动作继续使用本地状态机，只有 timer/cross-service/compensation 等明确需求才进入 durable adapter。
- [ ] 5.2 实现 Temporal-compatible durable adapter 的 step persistence、retry/cancel/timeout、worker-loss resume 和 IAR event/policy/idempotency 关联；验证 worker 丢失后从最后持久步骤恢复且不重复副作用。
- [ ] 5.3 实现带签名、版本、依赖、能力变更审批和可回滚记录的远程插件分发；验证签名无效、版本不兼容或 capability 扩大时安装/升级被拒绝。
- [ ] 5.4 实现跨语言 ABI 和多租户 control plane；验证远程插件仍遵守同一 Manifest、Schema、tenant、Policy Gate、审计和生命周期契约。
- [ ] 5.5 添加 durable/distribution/compatibility tests 和故障演练；验证 `npm run lint && npm run build && npm test` 通过，并完成从本地 Workflow 到 durable adapter 的迁移/回滚演示。

## Workflow follow-up

- 每个实现任务在 RED 前必须补齐该任务的模块边界、允许文件、排除范围、依赖、聚焦/广度命令和交接证据，并按 TDD 完成 RED → GREEN → broader verification。
- 每个任务完成后执行 plan-implementation consistency audit、适用领域审查、per-task audit，才可勾选任务并创建独立提交。
- Phase 1～5 全部完成后执行最终审计，确认 7 条验收标准和五个 capability spec 均有实现/测试证据。
- 通过最终审计后归档 `iar-five-phase-roadmap`，验证归档结果，并确认所有任务提交已合并回 `master`。
