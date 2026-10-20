# Proposal

## Why

SQLite 当前只能在已知 `sessionId` 的情况下读取快照、消息和事件，服务无法向客户端提供可恢复会话的列表。会话列表只需要轻量摘要，不应加载完整上下文、事实链或消息历史。

## What Changes

- 为 Persistence SPI 增加分页读取会话摘要的能力。
- SQLite 为每个已持久化会话维护轻量索引，摘要优先来自结构化上下文摘要，没有摘要时回退到首条用户消息。
- 增加 `GET /api/sessions`，返回摘要列表和不透明的下一页游标。
- 保持摘要为展示数据，不让它参与模型路由、事实校验、确认或副作用授权。
- 不返回最后一条消息，也不在会话列表接口中返回完整消息、事件或 BehaviorContext。

## Capabilities

### New Capabilities

- `session-summary-list`: 提供可分页、受边界约束的持久化会话摘要列表。

### Modified Capabilities

- `session-persistence-provider`: 扩展 Provider SPI 和 SQLite 实现，使其能够枚举会话摘要。

## Impact

- 影响 `@iar/persistence-spi`、`@iar/persistence-sqlite` 和 sandbox 生命周期 HTTP 路由。
- SQLite 增加内部会话索引表；既有消息、事件和快照表保持不变。
- 外部 Persistence Provider 需要实现新增的 `listSessions` 方法。
