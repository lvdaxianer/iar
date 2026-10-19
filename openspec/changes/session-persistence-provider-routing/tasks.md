# Tasks

## 1. Persistence SPI and session identity

- [x] 1.1 定义 `SessionIdentity`、消息记录、Provider Manifest、Provider 工厂和版本化 SPI，并用契约测试验证所有持久化输入都携带 `sessionId`。
- [x] 1.2 明确 `sessionId`、`runId`、`messageId`、`eventId`、`requestId`、`traceId` 的边界，兼容现有 Sandbox `legacy` 会话并通过构建和契约测试。

## 2. Provider Registry and built-in SQLite

- [x] 2.1 实现显式 Provider Registry 和动态加载器，验证 Provider 包、导出函数、SPI 版本和能力；用缺失包/错误版本测试验证稳定失败。
- [x] 2.2 将现有 SQLite Event/Snapshot 能力封装为内置 Provider，增加消息持久化、幂等和快照 revision 校验；通过 SQLite Provider 集成测试。
- [x] 2.3 实现 `flush`、`close`、有界异步写入和恢复读取，验证旧快照不能覆盖新快照且正常关闭排空已接受写入。

## 3. Hook event persistence

- [x] 3.1 增加 `message.received`、`message.sent`、`context.updated`、`session.restored` 等受控事件并验证事件契约和递归边界。
- [x] 3.2 实现 Provider 持久化订阅桥，验证异步投递、幂等、失败重试和故障不阻断主流程。
- [x] 3.3 将 Sandbox 消息、结构化上下文、动作结果和压缩结果接入订阅桥，并通过消息/快照回归测试验证事件顺序。

## 4. Scoped Plugin routing

- [x] 4.1 为 Function Manifest 增加固定 `actionTypes` 词表和 Schema 校验，验证未知动作被拒绝。
- [x] 4.2 为 BehaviorContext 增加受限 `routingScope`，验证连续追问复用 Plugin、显式业务切换替换 Plugin、歧义输入只澄清。
- [x] 4.3 调整候选构建为 Plugin 优先、Action 次级，验证十个 Plugin 同时有 `query` 时不会构造全局 Function 候选。
- [x] 4.4 保持 JEV 优先、Intent Model 统一决策契约和最终授权/策略/确认校验，并通过现有路由回归测试。

## 5. HTTP session recovery and documentation

- [ ] 5.1 让 HTTP 新建/恢复会话、普通消息、流式消息和确认请求贯穿同一个 `sessionId`，验证重启后恢复上下文再调用模型。
- [ ] 5.2 将 Provider 配置接入 Sandbox，默认使用内置 SQLite，验证外部 Provider 可以通过配置替换而不修改 Runtime。
- [ ] 5.3 更新根目录 `README.md`、`docs/README.md` 和 Provider 接入文档，验证命令、接口、事件和恢复示例与实现一致。
- [ ] 5.4 运行聚焦测试、全量 `npm test`、`npm run build` 和 `openspec validate session-persistence-provider-routing --strict`，完成代码审查、最终审计并归档 OpenSpec。

## Workflow follow-up

- 每个独立任务通过 TDD、代码审查、聚焦验证和提交后，再从 `master` 创建下一个任务 worktree 并合并回 `master`。
- 所有任务完成后同步批准的结构化上下文、Provider 和范围路由规范到 `openspec/specs/`，然后归档本变更。
