# Design

## Context

当前 `BehaviorContext` 已能从成功 Action 输出中投影有限可信事实，并通过异步 SQLite 快照恢复；但事实字段由核心固定枚举控制，响应模型只返回文本，导致可追问事实和澄清选项无法形成可恢复状态。具体动机见 `proposal.md`，行为要求见本变更的两个 delta spec。

## Goals / Non-Goals

**Goals:**

- 建立由插件显式声明、由运行时统一校验的通用 primitive facts 信封。
- 让响应模型可以返回有限、可校验的澄清元数据，并把它投影进会话状态。
- 让语义抽取、兜底回复、普通回复和流式回复收到等价的当前问题、verified facts 与 pending clarification。
- 保持快照异步写入、事件顺序、完整性哈希、压缩和恢复语义。
- 用跨业务测试证明“事实追问”和“短选项输入”不依赖领域关键词。

**Non-Goals:**

- 不把原始聊天历史重新作为模型决策输入。
- 不允许澄清选项直接选择或执行 Function、Plugin 或高风险 Action。
- 不改变 JEV/Intent Model 的优先级、候选集、授权和确认策略。
- 不为某个业务增加核心层专属字段或关键词分支。

## Decisions

### 1. 事实由插件显式声明，核心只做通用边界校验

保留 `facts` 作为成功输出中的显式信封，但移除核心对业务字段名称的固定枚举依赖。插件通过 `succeed(..., declaredFacts)` 或等价 manifest/output 契约显式提交事实；运行时只接受有限长度的安全键和 primitive 值，并在投影时补充 Function、Plugin、事件来源与 `verified` 状态。

这样新增排名、队列、预约或审批等业务只需在插件输出中声明事实，不需要修改上下文核心。完整业务对象、数组、自由文本和未声明输出仍不会进入 facts。

替代方案：继续扩展全局白名单。该方式实现简单，但每个新业务都会耦合核心契约，违背通用上下文目标，因此不采用。

### 2. 澄清元数据是响应契约的可选结构，不复用自然语言

`iar.response/v1` 增加可选 `clarification`，包含有限的 `kind`、`status` 和去重后的选项 `{ key, label }`。模型生成的原始元数据先经过响应适配器校验，非法元数据只保留安全文本或固定兜底，不写入状态。

pending 只表达“等待用户输入”和选项说明，不包含可执行 Action。用户输入的数字或短值仍需经过下一轮模型语义抽取、路由和策略门禁，不能由 pending 直接执行副作用。

替代方案：只把上一条助手文本放入 prompt。该方式无法可靠恢复、无法压缩校验，也会重新依赖原文，因此不采用。

### 3. 结构化上下文是唯一的后续理解入口

所有模型角色的用户输入保持分栏：当前用户问题、BehaviorContext、必要的不可变事件引用。不得传入 `recentMessages`。fallback prompt 明确要求优先读取 verified facts 和 pending clarification，缺少证据时反问，不得编造或隐式执行。

普通与流式路径共享同一 response 解析和 pending 投影逻辑，避免流式只显示文本而丢失结构化状态。

### 4. 澄清状态通过事件投影并随快照恢复

响应生成成功后追加结构化上下文事件，事件携带经过边界校验的 pending 数据；投影器更新 `BehaviorContext` 并触发现有的异步 SQLite snapshot。新回合在进入模型前读取最新投影，压缩只允许保留等价 pending 与 facts，否则保留旧状态并记录压缩失败。

替代方案：只依赖内存中的 response 结果。该方式在重启、会话迁移和压缩后丢失事实，因此不采用。

## Risks / Trade-offs

- [模型返回非法澄清结构] → 响应适配器 fail-closed，只保存安全文本，不改变 pending。
- [facts 键过度开放] → 限制键格式、长度、数量和值类型；只接受插件显式 facts，拒绝业务输出中的任意字段。
- [pending 被误当作执行授权] → 契约与提示词明确 pending 仅供理解，下一轮仍必须重新完成语义、路由、授权和策略门禁。
- [流式文本已发送但元数据无效] → 文本可安全展示，只有完整且校验通过的响应元数据才进入状态；无效时保持旧上下文。
- [旧快照缺少新字段] → 新字段保持可选并使用兼容默认值，旧快照继续恢复为无 pending clarification 的状态。

## Migration Plan

1. 先扩展契约和投影校验，保持旧 facts 输出和旧 response 文本兼容。
2. 更新 sandbox 插件的显式 facts 输出和模型提示词。
3. 增加快照恢复、压缩、普通/流式和无模型 fallback 的回归测试。
4. 更新 `docs/README.md` 的 BehaviorContext 技术方案。
5. 验证通过后同步主规范并归档 OpenSpec change；若需要回滚，删除新增 pending 元数据消费即可，旧 facts 和旧文本路径仍可工作。
