# Design

## Context

See `proposal.md` for the motivation. 当前语义抽取 Prompt 在 agent-sandbox 中拼装，Intent Model 决策输入在 `@iar/runtime` 中构造；两条路径都接受结构化上下文和有限原文，但没有共享的跨集合预算。现有各字段的独立边界仍然有效，不能通过扩大窗口解决总量问题。

## Goals / Non-Goals

**Goals:**

- 让 semantic.extract、function.select 和 plugin.select 的模型输入在 provider 调用前拥有可验证的总字符上限。
- 保留当前消息、当前执行状态、候选边界和最新可信事实；以完整消息、轮次和记录为单位裁剪较旧上下文。
- 让裁剪结果可复用、可测试，并将不含原文的预算诊断接入现有 ModelGateway audit。
- 在预算无法满足必需输入时 fail-closed，不发送超预算请求，不改变授权和 fallback 边界。

**Non-Goals:**

- 不改变 `iar.decision/v1`、semantic frame 或 Function/Plugin 授权协议。
- 不为 response.generate 和 context.compact 引入本次意图预算策略。
- 不实现 EventLog 检索、跨会话记忆、偏好记忆、事实版本化、自动压缩或 Prompt Cache。

## Decisions

### 1. 在 runtime 提供纯函数预算组装器

新增 `packages/runtime/src/intent/decision/model-gateway/context-budget.ts`，提供固定的 `24_000` 字符初始预算、分层输入类型、完整单元裁剪和脱敏诊断。该模块只依赖 `@iar/contracts` 的 JSON/BehaviorContext 类型，不依赖 agent-sandbox。

语义模型和 Intent Model 决策都通过该模块处理各自的上下文。agent-sandbox 可以从 `@iar/runtime` 导入同一实现，避免 semantic Prompt 和 decision input 各自维护裁剪逻辑。

### 2. 采用“必需层 + 可裁剪层”而不是直接切字符串

当前消息、当前 route/workflow/pending action、候选请求和候选能力边界属于必需输入；必需部分序列化后超过预算时直接返回稳定的预算失败，不对 JSON 文本做半截截断。summary、recent messages 和 conversation turns 属于可裁剪层，按从旧到新的顺序移除完整项；facts 和 slots 只保留经过现有状态投影的完整记录。

这样可以避免把半个 JSON、半条消息或半个事实记录交给模型，也不会因为裁剪候选项而改变有限决策集合。候选边界仍由现有请求校验和授权流程负责。

### 3. 诊断元数据走 invocation，不进入 Prompt 正文

为 `ModelInvocation` 增加可选的内部 `contextBudget` 诊断快照，ModelGateway 将其合并到现有脱敏 audit metadata；provider 只接收冻结的 `input`，不接收该诊断字段。诊断只包含输入字符数、是否裁剪和每层保留数量，不保存用户原文、完整 Prompt、候选 ID 或凭证。

这比从 provider 日志反推 Prompt 大小更可靠，也保持现有 audit 不记录原始模型请求的约束。

### 4. provider 失败和预算失败都保持 fail-closed

预算组装错误在 provider 调用前转换为现有稳定的 `model.invalid_request` 结果；模型不可用、超时和 schema 失败继续走现有 gateway retry/fallback。预算逻辑不自动扩大候选、不回退到旧的无界输入，也不把 raw history 提升为可信状态。

### 5. 先覆盖意图识别链，不扩展回复链

本次只接入 semantic.extract、function.select 和 plugin.select。response.generate 仍使用现有输入，以避免短期变更同时改变回复质量和意图路由行为；后续如果需要统一回复预算，再以独立变更评估其层级和验收指标。

## Risks / Trade-offs

- [风险] 24,000 字符不是精确 token 数。→ 作为短期 provider 前的保守硬上限，并在 audit 中记录字符数；后续再按实际模型 tokenizer 替换计量实现。
- [风险] 必需候选描述本身超过预算会导致本轮无法路由。→ 直接 fail-closed 并保留现有澄清/fallback，不静默删除候选；通过测试暴露需要缩短候选描述或拆分候选的问题。
- [风险] 裁剪较早 conversation turns 会降低跨窗口指代能力。→ 在短期版本明确能力边界，优先保留 summary、focus 和最新可信状态；EventLog 检索另立变更。
- [风险] audit metadata 扩展可能影响现有白名单。→ 只使用有限数字、布尔和固定层名称，并补充审计边界测试。

## Migration Plan

1. 先加入预算纯函数和失败/裁剪测试，不改变现有调用行为。
2. 将 semantic.extract 和 Intent Model decision 接入预算组装器。
3. 增加长会话集成场景与审计字段，运行现有 model-gateway、session 和完整测试。
4. 若发现实际会话需要更大预算，只调整版本化常量和测试证据，不恢复无界输入。

回滚时移除两条调用链的预算组装即可；不会涉及数据库迁移或持久化格式变更。
