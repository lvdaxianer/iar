# Design

## Context

See `proposal.md` for the motivation and externally visible behavior. 当前 `BehaviorContext` 使用 `facts: Record<string, TrustedFact>`，投影器以 `functionId.field` 作为键，因此相同字段的后续结果会覆盖前一结果。最近消息已经由 Provider 独立保存并以有界窗口提供给模型；它们必须继续保持非可信属性。

本变更横跨 contracts、event projection、model gateway、session persistence 和 compaction。现有事件日志是恢复真相源，SQLite 快照以 JSON 保存 BehaviorContext，模型输出通过严格 schema 校验后才能进入运行时。

## Goals / Non-Goals

**Goals:**

- 用有界、追加式、可排序且可追溯的事实记录替代覆盖式事实 map。
- 让自然语言顺序关系通过稳定的通用模型契约进入运行时，并由运行时完成最终解析和校验。
- 在事件重放、SQLite 恢复、异步快照、上下文压缩和流式/非流式模型调用中保持同一事实链。
- 为旧快照提供一次性兼容归一化，并让无效关系安全失败、动态澄清。

**Non-Goals:**

- 不在 Runtime 增加任何领域实体、业务字段、关键词或业务分支。
- 不把原始消息写入可信事实链，也不允许模型输出直接授权 Function、Plugin 或副作用。
- 不改变现有 JEV、策略、确认和最终能力重校验边界。
- 不引入新的数据库表；事实链仍属于版本化会话快照和事件投影。

## Decisions

### 1. 使用 `factHistory.records` 作为新的可信事实容器

`BehaviorContext` 增加版本化的 `factHistory`：

```ts
type VerifiedFactRecord = {
  recordId: string;
  sequence: number;
  sourceEventId: string;
  functionId: string;
  pluginId: string;
  values: Record<string, TrustedFactValue>;
  createdAt: string;
};

type VerifiedFactHistory = {
  records: VerifiedFactRecord[];
  focusRecordId?: string;
};
```

`functionId`、`pluginId` 和 `values` 的 key 都只按不透明字符串处理。一次成功的 `action.completed` 事件产生一条记录；同一事件重放通过 `sourceEventId` 去重，记录 ID 必须在重放中稳定。追加前执行记录数量、键长度和值大小校验，超过边界时保留已有状态并记录稳定失败结果。

选择记录集合而不是 `Record<key, value>` 的原因是需要表达同名字段的多次出现和顺序。替代方案是给旧 map 的 key 加序号，但那仍然把来源、顺序和事实值耦合在业务式字符串中，且无法自然表达当前焦点。

### 2. 将模型引用改为通用关系意图

语义帧使用新的、严格校验的引用结构：

```ts
type ReferenceRelation = 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset';

type SemanticReference = {
  text: string;
  anchorRecordId?: string;
  relation: ReferenceRelation;
  scope?: 'same_fact_chain';
  offset?: number;
};
```

模型只返回已有不透明记录 ID 和关系，不返回领域值作为解析依据。`offset` 只允许有界整数；`anchorRecordId` 缺失时，运行时仅可使用受信任的 `focusRecordId`，不能从原始消息猜测。模型适配器、schema 和提示词统一升级到新的语义帧版本；旧版本引用只作为兼容输入保留，不得绕过新运行时校验。

选择“模型归一化、Runtime 解析”而不是让模型直接返回目标值，是因为“上一个”依赖会话内的真实顺序，模型无法成为事件顺序的权威来源。运行时解析也避免模型伪造不存在的记录或把历史文本当成执行授权。

### 3. 由 Runtime 使用有序序列解析关系

解析器按以下顺序工作：

1. 校验引用中的记录 ID 属于当前会话的 `factHistory`，并校验关系和 offset 的边界。
2. 选择锚点：显式 `anchorRecordId` 优先，否则使用当前 `focusRecordId`；没有锚点时返回未解决结果。
3. 按 `sequence` 在同一事实链中计算 `current`、`previous`、`next`、`first`、`last` 或 `offset` 目标。
4. 校验目标记录仍在当前有界历史中，并将解析结果交给只读回答或后续正常路由流程。
5. 成功解析后更新 focus；无目标、过期 ID 或多义结果则生成数据化澄清，不执行副作用。

澄清选项来自当前事实记录和运行时过滤后的 Plugin 描述，使用不透明 record ID 与动态展示元数据；核心代码不包含任何领域词或固定能力列表。

### 4. 事件、快照和压缩共享同一事实边界

事件投影负责追加记录并更新 `focusRecordId`；`criticalFieldHash` 覆盖完整 `factHistory`，因此压缩候选若删除、重排、改写事实或来源会被拒绝。压缩模型只接收结构化状态和事件，不接收最近原始消息；生成的摘要只能作为非可信摘要，不能新增事实记录。

SQLite Provider 不需要新增业务表：现有事件、消息和 JSON 快照存储继续使用 `sessionId`、revision 和事件幂等键。快照加载先按版本校验，再将旧 `facts` map 中的每个已验证条目转换为兼容事实记录；转换使用旧条目自身的 `sourceEventId`、`functionId`、`pluginId` 和 `field`，不解析或硬编码任何业务名称。归一化后的新快照只按新结构写回。

### 5. 保持原始消息与可信事实分离

模型调用输入同时包含：当前消息、最近 N 条有界原始消息、`factHistory`、pending clarification 和动态 Plugin 描述。原始消息在提示词中明确标为非可信数据；它不能改变路由、确认、事实状态或能力边界。语义提取、决策、fallback 和 response 四类调用共享同一输入裁剪和序列化逻辑，避免流式与非流式路径分叉。

## Risks / Trade-offs

- [事实历史容量有限，较早记录可能被裁剪] → 使用明确的最大记录数、每条记录和值大小上限；裁剪只发生在有界策略内，并在无目标时安全澄清，不伪造“上一个”。
- [语义帧版本升级可能影响外部模型 Provider] → 保留版本化 validator 和兼容读取路径；新字段只在新版本启用，未知字段继续拒绝。
- [旧快照没有一个统一的事实记录边界] → 按旧条目生成可追溯兼容记录，保守保留而不合并；后续事件按新规则追加。
- [模型返回有效但不相关的记录 ID] → Runtime 强制检查当前 session、事实链和序列，解析失败只进入动态澄清。
- [并发 action.completed 事件导致序号竞争] → 在同一 session 的投影/快照写入边界内按事件序列化追加，并以事件 ID 去重后再分配序号。
- [历史测试和示例包含领域样例] → 领域样例只能存在于测试 fixture 或 Plugin manifest；共享 contracts/runtime/prompt 代码使用动态占位数据并增加静态扫描测试。

## Migration Plan

1. 先新增 contracts、schema 和模型引用版本的 RED 测试，再实现 `factHistory` 类型、validator 和 relation 输出校验。
2. 改造事件投影、上下文构建、回复/参数继承和 compaction，使新链成为唯一可信读取路径；为旧 `facts` 快照加入读取归一化。
3. 更新 SQLite/Provider 恢复测试、模型输入测试、流式/非流式 parity 测试及“两个同名结果 + 上一个”端到端测试。
4. 完成全量测试、lint、package verify、构建和 OpenSpec 严格校验后，逐任务提交并合并回 `master`。
5. 回滚时保留事件日志和旧快照读取兼容层；若新关系解析不可用，旧版本仍可读取旧事实，但不得恢复覆盖式写入作为新路径。

## Open Questions

无。记录上限、最近消息上限和 unresolved 阈值沿用现有配置边界，不改变本次规格或任务拆分。
