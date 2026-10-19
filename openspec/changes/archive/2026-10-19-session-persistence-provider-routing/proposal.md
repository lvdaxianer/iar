# Proposal

## Why

IAR 已经具备结构化 BehaviorContext、Hook/StateEvent 订阅、PluginHost 和 SQLite 快照能力，但会话消息、上下文快照和外部持久化实现尚未形成统一的可替换边界；路由也无法把 Plugin 业务范围、Function 和固定动作类型稳定地组合起来。结果是接入方容易被 SQLite 绑定，短回复会话容易丢失当前业务范围，且每轮候选可能被无界扩大。

## What Changes

- 新增版本化 Session Persistence SPI，定义消息、事件、BehaviorContext 快照、恢复、刷盘和关闭契约。
- 将 SQLite 实现收敛为内置 Persistence Provider；默认可用，但 Runtime 只依赖 SPI，不直接依赖 SQLite。
- 新增 Provider Registry 和配置驱动的动态加载入口，允许外部 npm 包实现相同 SPI。
- 标准化 `sessionId`、`runId`、`messageId`、`eventId` 和 `traceId` 的职责，并让持久化记录以 `sessionId` 关联。
- 增加消息接收、消息发送和结构化上下文更新事件，使用异步订阅保存消息和快照。
- 为 Function Manifest 增加固定 `actionTypes`，路由改为先确定 Plugin 业务范围，再在 Plugin 内按动作类型缩小 Function 候选。
- 将当前会话路由范围纳入结构化上下文，连续追问保留当前 Plugin，新问题和明确切换替换候选范围。
- 保留 JEV 优先、Intent Model 兼容返回契约、最终授权/策略/确认校验，以及现有 Hook 的同步阻断和异步观测语义。
- 补充 Provider、会话恢复、异步持久化、路由范围、短回复追问和跨会话隔离测试，并更新根目录及 `docs/` 技术文档。

## Capabilities

### New Capabilities

- `session-persistence-provider`: 可替换的会话持久化 Provider SPI、Provider 加载、内置 SQLite 实现和恢复语义。
- `scoped-plugin-routing`: Plugin 优先、动作类型次级、会话范围持续管理的有限路由能力。

### Modified Capabilities

- `behavior-state`: BehaviorContext 和恢复快照需要携带稳定的会话关联及当前路由范围。
- `structured-model-context`: 每轮模型调用和异步持久化需要使用统一的 session identity、消息事件和路由范围。
- `runtime-contracts`: Function Manifest 增加固定动作类型，系统 Provider 插件必须通过版本化 SPI 加载且不进入业务路由。

## Impact

- 影响 `packages/contracts`、`packages/runtime`、`packages/subscriptions`、`packages/storage`、`packages/plugin-host` 和 Sandbox 组合根。
- 新增 Persistence SPI/Runtime/SQLite workspace 包或等价模块，并保持当前公共包导出路径兼容。
- 影响 SQLite 表结构和 Snapshot 记录，需要保留旧快照读取兼容策略。
- 影响 Sandbox HTTP 会话入口、模型调用上下文和恢复流程；不改变用户现有的独立会话 URL 形态。
- 不在本次变更中引入真实租户身份系统；保留已有授权接口，路由筛选不以租户为语义候选条件。
