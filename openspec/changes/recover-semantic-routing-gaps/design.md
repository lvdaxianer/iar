# Design

## Context

See `proposal.md` for the user-facing problem and scope. 当前 Sandbox 已有 `TurnTimingTracker` 和安全日志白名单，但 `semantic.extract` 完成后没有记录结构化帧的关键字段状态；`routeAsync` 又以 `action`/`intent` 是否已知作为是否进入 nested route 的门槛，导致“抽取不完整”和“没有候选”在 UI/日志上难以区分。响应模型可以生成文字，但不具备执行权限；运行时必须在响应模型之前决定是否允许继续。

## Goals / Non-Goals

**Goals:**

- 在语义抽取完成、路由门禁、候选校验、确认等待、执行和桥接失败边界输出统一 trace-correlated 的安全诊断。
- 让诊断能明确回答：抽取字段是否存在、哪一字段缺失、是否调用了路由模型、候选是否为空、为何没有执行。
- 对缺失字段建立确定性澄清状态；用户补充后作为新输入重新抽取和验证，任何模型文本都不能直接授权执行。
- 保持现有 OpenAI-compatible nested Plugin/Function 契约、JEV/Intent Model 优先级、Response Model 回复职责和敏感信息日志边界不变。

**Non-Goals:**

- 不在运行时增加关键词规则来替代语义模型。
- 不记录原始用户文本、完整 prompt、模型 response、token 或 thinking 原文。
- 不通过自动重试或模型兜底猜测缺失的 Plugin、Function、Operation 或业务参数。
- 不改变已通过契约、授权、策略和确认门禁的 Function 执行语义。

## Decisions

### 1. 在两处边界记录诊断，而不是记录模型原文

在 `semantic.extract` 返回后记录 `semantic.frame` 摘要，在路由器返回后记录 `route.decision` 摘要。字段只包含受控枚举、布尔值、有限数量和经过标识符白名单校验的 IDs，例如 `hasIntent`、`hasAction`、`semanticAction`、`candidateCount`、`routeStatus`、`reasonCode`、`nextStage`。继续使用现有 `writeSafeLog` 白名单和 bilingual writer；不采用“把完整请求/响应写到日志”的做法，因为这会泄露用户输入并破坏日志边界。

### 2. 用稳定原因码区分语义缺口和路由无候选

新增原因码按门禁分层：`semantic_incomplete` 表示抽取结果缺少必需字段；`route_not_proposed` 表示因语义不完整而跳过 proposal；`candidate_empty` 表示语义完整但没有可用候选；`route_contract_invalid` 表示 proposal 标识或参数契约校验失败；`bridge_timeout`/`bridge_unavailable` 表示传输层故障。保留原有兼容状态字段，但在新的诊断字段中不再用 `plugin_noul` 统称上述情况。

### 3. 运行时生成澄清，Response Model 只负责表达

新增一个纯运行时的 semantic recovery 判定：根据当前行为上下文、pending clarification 和已授权的有限候选计算缺失字段。它返回稳定的 `missingFields`、`allowedValueCount` 和 `nextAction`，并把这些信息交给现有回复层表达。回复模型可以把结构化结果写成自然语言，但运行时不读取其正文来决定执行；只有下一轮语义抽取重新形成完整帧并通过全部路由/策略/确认门禁时才可执行。

### 4. 不对“执行这个”做模糊自动绑定

重复确认仅在已有、未过期且与当前会话绑定的结构化 pending action 存在时才可进入确认流程。若上一轮只是模型生成了澄清文本而没有形成 pending action，运行时返回缺少目标/操作的确定性追问；不从最近自然语言中猜测目标，也不把模型的 `confirmed` 文本当作确认事件。

### 5. 先用 focused tests 固化停止点，再扩展集成测试

先添加安全日志序列化测试和 session turn 测试，覆盖抽取缺 action、完整帧、候选为空、桥接失败和补问后重新路由。每个测试先在当前实现上失败，再以最小实现通过；随后运行相关 Sandbox、routing、observability 和全量测试。

## Risks / Trade-offs

- [日志字段白名单过严导致诊断字段被丢弃] → 为字段定义有限枚举/标识符校验并增加序列化断言，禁止直接放宽为任意字符串。
- [模型偶发返回部分正确帧] → 运行时按必需字段完整性 fail-closed，并用明确缺失字段追问，不自动猜测。
- [用户连续回复造成无限澄清] → 沿用现有 bounded unresolved streak，达到阈值后只展示有限候选或稳定不可用说明。
- [旧客户端依赖 `plugin_noul`] → 保留旧外层 status/reason 兼容字段，在新增诊断中提供细分原因；通过现有集成测试确保旧协议不变。
- [桥接故障被误判为语义失败] → 在 transport/turn boundary 记录独立失败类别，并在未获得 route evidence 时明确不生成伪造 timing/route 结果。

## Migration Plan

1. 先发布安全诊断和确定性缺口判定；新增字段均为可选，不改变已有客户端响应结构。
2. 观察真实日志中 `semantic.frame` 与 `route.decision` 的分布，确认抽取缺口、候选缺失和桥接错误能分离。
3. 在 Sandbox 重启后验证完整日志链路和重复确认场景；若出现兼容问题，可关闭新增诊断输出而保留既有路由逻辑。
4. 新旧客户端无需迁移；恢复状态沿用已有 BehaviorContext/pending clarification 校验。
