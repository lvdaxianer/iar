# Design

## Context

Sandbox 的十个业务 Function 共用一个输入 Schema，Handler 仍保留 operation 缺省兼容逻辑。这个兼容层在真实模型只命中 Function、没有明确 Operation 时会把 `stats`、`list`、`create` 等默认值带入动作构造，导致“需要反问”的场景被误判为完整请求。现有参数收集器能按 Schema 收集字段，但 Operation 缺失时只显示通用字段名，且真实模型脚本只检查 HTTP/结构化状态，没有检查澄清语义。

目标是将运行时决策拆成清晰的边界：

`Function 命中 → Operation 目录澄清 → Operation 选择 → Schema 参数补全 → 策略/确认 → 执行`

所有步骤在一个 `piSessionId` 内恢复同一个已验证 Function/Plugin；真实模型只负责提出有限候选，不能授予执行权限。

## Goals / Non-Goals

**Goals:**

- 对缺少唯一 Operation 的请求 fail-closed，并展示注册表中的有限 Operation 目录。
- 将 Operation 澄清与普通参数澄清区分开，优先补齐路由槽位，再补业务槽位。
- 同一会话中按字段名继承已验证的 Function、Plugin、Operation 和参数，当前轮值覆盖旧值。
- 补全后统一复用 Schema、授权、策略、确认、幂等和 Handler 执行门禁。
- 用真实 8878 服务执行附件中的 50 个场景，语义断言失败时输出最小可诊断证据并可重复运行。

**Non-Goals:**

- 不用关键词规则替代真实模型的 Function 识别。
- 不改变 Handler 的兼容代码作为独立调用 API 的行为；本变更只禁止会话路由在 Operation 未确定时进入 Handler。
- 不在真实模型测试中创建第二个会话、切换标签或自动确认高风险动作。
- 不把模型回复正文、原始 prompt、凭据或业务敏感参数写入日志。

## Decisions

### 1. Operation 解析只接受三类证据

在 `prepareFunctionInput` 之前，Operation 只有以下来源可执行：

1. 当前语义帧/Function-call proposal 中的合法 Operation，且用户当前文本存在该 Operation 的注册描述或明确操作词证据；
2. 当前 Function 的唯一 Operation（没有同 kind 竞争项时）；
3. 同一会话中已验证的 Operation collection slot，且当前输入没有切换话题或明确覆盖。

模型单独返回的默认 Operation 不属于证据。无证据时返回 `operation_missing`，在 `RouteEvidence.expectedOperation` 中只保留有限的 Operation ID 列表；不构造 Action。

### 2. Operation 澄清使用注册目录，不复用通用字段文案

新增纯函数把 `PluginOperation[]` 投影为最多 `MAX_CLARIFICATION_OPTIONS` 个稳定选项（ID、短描述、kind），并生成“请从……选择操作”的回复。它不读取 Handler 默认值，也不接受模型新增的 Operation。参数 collection 仍保存 `operation` 字段，使用户在下一轮回复 `统计`、`stats` 或有限选项 key 时按字段名合并。

### 3. 同会话答案先收集再路由

当前已有 `BehaviorContext.collection` 时，普通和流式入口都先恢复其 Function/Plugin。若 collection 的缺失字段包含 Operation，则对当前输入只尝试匹配活动目录；成功后重新构造输入，仍缺业务字段则只追问业务字段。匹配失败保持原 collection，不让自然语言把目标切换到别的 Plugin。

### 4. 真实验收器检查语义而不只检查传输

扩展 `scripts/run-real-pi-50-scenarios.mjs`：

- 启动/连接 `PI_HOST_URL=http://127.0.0.1:8878`，所有请求使用同一个显式 `PI_SESSION_ID`；不调用 session 列表、不创建第二个会话、不切换会话。
- 每个场景解析 bridge response、route evidence、reply、pending 和 collection；对独立场景在同一个会话内安全取消意外 pending/collection，然后继续下一场景。
- 场景期望包含 `clarification` / `awaiting_confirmation` / `handled`、Function/Plugin、reasonCode、回复关键字、是否有 pending，以及多轮补全后的继承关系。
- 只要一条语义断言失败，脚本以非零状态退出，并打印场景编号、用户输入、期望摘要和脱敏实际摘要。

### 5. 通过 focused RED 测试锁定缺口

先在 `tests/integration/agent-sandbox` 增加运行时测试，覆盖：

- 缺 Operation 不进入 Handler，不产生 pending，回复包含有限目录；
- Operation 选择后同 Function/Plugin 继续，缺参数只追问参数；
- 非法 Operation 不跨 Plugin/Function；
- 完整高风险请求仍只进入确认；
- 50 场景脚本的语义断言器能拒绝“技术成功但语义错误”。

测试先在当前实现失败，再做最小修复；随后跑相关测试、build/lint、全量测试和 8878 真实模型验收。

## Risks / Trade-offs

- 某些自然语言本身只表达“查询”而未区分 `search`/`stats`/`list`，会比旧默认策略多一轮追问；这是安全和可解释性的必要代价。
- 真实模型输出具有随机性；验收器只断言稳定的安全边界、身份和目录关键字，不断言回复全文。
- 50 个场景共用会话会积累历史；脚本在独立场景之间只清理 pending/collection，不重置 session，从而同时验证状态隔离和继续能力。
- operation 目录描述可能较长；投影按现有有界常量截断，必要时保留稳定 ID 供用户选择。

## Open Questions

无。Operation 目录、同会话继承、真实模型地址和单会话约束均由本变更固定。

## Migration Plan

1. 先合入运行时 focused tests 与 Operation 澄清实现。
2. 在 8878 服务上用显式单 session 运行 50 场景，记录失败样例。
3. 每次修改后重复 focused tests、全量测试和 50 场景真实验收，直到全部通过。
4. 完成 code review、OpenSpec strict validation 和最终 worktree/master 审计后归档变更。
