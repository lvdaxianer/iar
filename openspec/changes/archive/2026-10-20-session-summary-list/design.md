# Design

## Context

会话恢复当前需要调用方已经知道 `sessionId`。消息、事件和快照分别按会话读取，虽然 SQLite 中存在会话标识，但没有稳定的枚举接口。会话列表用于选择和恢复会话，只需要展示摘要，不需要把可信状态或原始消息暴露给列表调用方。

## Goals / Non-Goals

**Goals:**

- 提供 Provider 无关的分页会话摘要查询。
- 摘要优先使用已持久化的 `BehaviorContext.summary.text`。
- 没有结构化摘要时，使用该会话首条用户消息的有界文本作为展示摘要。
- 支持只有消息、只有快照或只有事件的会话记录。
- 保持查询有界、顺序稳定、游标不携带可解释业务信息。

**Non-Goals:**

- 不返回最后一条消息。
- 不返回完整消息、事件、事实链、路由或权限信息。
- 不让摘要参与模型输入、路由、确认、事实投影或执行授权。
- 不在 Runtime 或 Provider 中硬编码业务字段或业务能力。

## Decisions

### 1. Provider contract

Persistence SPI 增加：

```ts
type SessionSummary = {
  sessionId: string;
  summary?: string;
};

type SessionListQuery = {
  limit?: number;
  cursor?: string;
};

type SessionListPage = {
  sessions: SessionSummary[];
  nextCursor?: string;
};
```

`limit` 使用固定默认值和最大值，`cursor` 由 Provider 生成并校验。调用方通过连续请求游标获得全部会话，避免默认无界读取。

### 2. SQLite index

SQLite 新增内部 `iar_session_index` 表，按 `session_id` 保存摘要和用于稳定排序的内部活动序号。消息、事件和快照写入时同步 upsert 索引：

- 首条用户消息只在摘要为空时作为 fallback；文本在写入索引前截断到统一边界。
- 快照包含非空 `context.summary.text` 时覆盖展示摘要。
- 只有消息、事件或快照的会话都创建索引行。
- 列表按内部活动序号倒序、`session_id` 倒序作为稳定 tie-breaker。

索引只服务列表展示，不成为恢复真相源；完整状态仍由快照和事件恢复。

### 3. HTTP API

新增 `GET /api/sessions?limit=<n>&cursor=<opaque>`。响应只包含 `sessions` 和可选 `nextCursor`。没有配置 Persistence Provider 时返回空列表，避免影响内存测试和兼容模式；非法分页参数返回稳定 400 错误。

### 4. Safety and compatibility

列表摘要被视为不可信展示数据，不进入 `BehaviorContext`，不传给模型，也不影响会话恢复。旧数据库启动时通过 `CREATE TABLE IF NOT EXISTS` 创建索引；既有消息、事件和快照不会被改写。

## Testing

- SPI/SQLite 测试覆盖摘要来源优先级、首条用户消息 fallback、分页游标、空列表和会话隔离。
- 重启测试验证索引在关闭/重新打开 Provider 后仍可读取。
- HTTP 测试验证默认分页、游标翻页、非法参数和无 Provider 兼容行为。
- 全量测试、lint、build、包分发校验和 OpenSpec 严格校验作为交付门禁。
