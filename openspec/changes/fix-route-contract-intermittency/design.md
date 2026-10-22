# Design

## Context

当前嵌套路由已经把 Plugin、Function、Operation 和 arguments 放在一次 `route.propose` 结果中，但执行前的输入构造仍兼容旧的 `slots.operation` 路径，并且把多个契约错误折叠成同一个缺失字段结果。现有日志能记录阶段耗时和 Trace，却没有保留安全的路由提案摘要，因此无法区分模型漏字段、非法 ID、外层/内层冲突或参数 Schema 错误。

本设计遵循现有 `iar.function-call/v1`、Plugin 所有权、Function 输入 Schema、确认策略和 `response.generate` 边界；不改变 Function Handler 的执行权限，也不把自然语言意图重新作为程序路由依据。

## Goals / Non-Goals

**Goals:**

- 让嵌套路由的外层 `operation` 成为唯一权威操作身份，并兼容现有 Function 输入需要 operation 的 Handler。
- 在执行前稳定区分 `operation_missing`、`operation_not_allowed`、`operation_conflict`、参数 Schema 错误和上游模型错误。
- 对契约失败 fail closed：不构造可执行 Action、不调用 Handler、不伪造成功回复。
- 在 JSON 和 pretty 日志中输出中英双语标签、Trace/Request 关联、期望值、实际值、reasonCode 和阻断结果，同时禁止原始 Prompt/模型全文/凭据进入日志。
- 让 Host/Sandbox 的失败结果保留 reasonCode、Trace 和已完成耗时，便于从 UI 追到日志。

**Non-Goals:**

- 不增加第二次模型修复调用；避免为偶发结构错误再增加一轮延迟。
- 不用自然语言关键词推断 operation，不扩大模型可选候选，也不改变 Plugin/Function 的授权边界。
- 不改变查询结果交给 Response Model 汇总、确认动作跳过普通回复等既有响应策略。
- 不引入新的日志基础设施或外部 API；复用现有 safe-log 和 timing 传输协议。

## Decisions

### 1. Operation identity uses one canonical source

`route.propose` 的外层 `operation` 是路由身份。模型工具描述和提示词明确要求 `arguments` 只包含业务参数，不重复 operation。运行时仍可以为兼容旧 Handler 将已校验的外层 operation 注入最终 Function 输入，但注入由程序完成，不由模型决定。

如果模型同时返回内层 operation：

- 与外层一致时，运行时移除重复字段，仅保留外层已校验值，兼容现有模型和旧测试；
- 与外层不一致时，返回 `operation_conflict`，记录两个值并阻断执行；
- 外层缺失时，返回 `operation_missing`，记录当前 Function 的有限允许 operation 列表。

选择拒绝而不是静默采用其中一个值，是因为动作 Function 可能产生不可逆副作用；选择不重试模型，是因为本项目当前目标包含 2.5 秒级响应，确定性校验比隐藏重试更可控。

### 2. Validation failures become typed, safe diagnostics

执行准备函数返回带 reasonCode 的稳定结果，而不是只返回 `missing: string[]`。错误结果携带安全诊断对象：Plugin/Function/Operation ID、允许 operation 列表、期望值、实际值和处理决策。诊断对象只允许有限枚举、短字符串和小数组，并在日志边界再次经过字段白名单和长度限制。

用户可见消息按 reasonCode 生成，避免暴露模型原始输出；Host 结果保留 reasonCode、Trace 和已完成 stage timing。确认、执行和 Response Model 流程只接受通过完整校验的输入。

### 3. Logging follows milestone/error/debug boundaries

- `INFO`：记录正常 stage 和 turn 摘要；
- `WARN`：记录模型契约失败、超时、拒绝和安全阻断，并包含 expected/actual；
- `ERROR`：只用于未预期异常或无法恢复的基础设施错误，并保留错误上下文；
- `DEBUG`：如需诊断只记录受控的字段名和候选摘要，不记录原始 Prompt、用户全文或模型全文。

新增固定事件 `model.contract_violation`，复用现有双语 pretty writer 和 JSON 字段白名单。高频耗时分布仍由现有 timing/metrics 负责，不在日志中逐条展开大 payload。

### 4. Host diagnostics reuse existing timing boundary

不新增外部 API。将契约 reasonCode 和安全诊断摘要挂到现有 turn failure/route evidence，并让 Sandbox message footer 和 Timing 面板在存在字段时展示简短错误码与 Trace。没有失败字段时保持现有 UI，避免渲染虚构的 expected/actual。

### Alternatives considered

- **只修改 Prompt**：不能保证模型始终遵守格式，也无法解释已经发生的错误，放弃。
- **冲突时静默采用外层 operation**：会掩盖参数污染，在高风险动作中不安全，放弃。
- **冲突或缺失时自动追加一次模型调用**：可能提高召回率，但直接增加端到端延迟和失败面；先采用单调用严格校验，放弃默认重试。
- **保留现有通用“缺少 operation”错误**：无法区分故障来源，放弃。

## Risks / Trade-offs

- [模型仍可能漏返回 operation] → 严格 Schema、候选 operation 列表和明确的用户重试提示；动作不执行并记录 `operation_missing`。
- [旧 Handler 仍在输入 Schema 中声明 operation] → 运行时在最终 Action 输入边界注入外层已校验值，避免直接破坏现有 Handler。
- [日志 expected/actual 可能增加敏感暴露] → 只记录稳定 ID、允许枚举和 bounded 值，禁止用户文本、Prompt、全文响应和凭据。
- [新增错误字段影响旧 Host] → 字段保持可选，旧 Host 继续读取原有 status/source/timing；新 UI 只在字段存在时渲染。
- [没有二次模型修复导致部分请求仍需用户重试] → 以安全阻断和可诊断性优先；后续可基于日志统计决定是否增加受控、可配置的修复策略。

## Migration Plan

1. 先增加类型化校验结果、safe-log 事件和测试，确保失败路径不会执行 Handler。
2. 更新嵌套路由提示/工具描述，声明 operation 只能出现在外层。
3. 增加 Host/Sandbox 可选诊断展示并验证旧结果兼容。
4. 通过单元、集成、构建和重复真实请求验证后合并任务分支。
5. 回滚时恢复旧提示和字段消费逻辑即可；新增日志事件和可选响应字段不会改变既有合法请求的执行路径。
