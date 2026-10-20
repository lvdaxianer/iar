# 会话持久化 Provider 与范围路由设计

## 目标

在不绑定 SQLite 的前提下，为 IAR 建立可替换的会话持久化 Provider；同时把 Plugin、Function、固定动作类型和会话结构化上下文组织成可持续收敛的路由流程。

## 核心原则

1. `sessionId` 是会话聚合主键，`runId` 是一次工作流运行，不能由模型生成。
2. Runtime 只依赖 Persistence SPI；SQLite 是内置 Provider，不是核心实现。
3. Hook 发布事件，Provider 保存数据；业务 Function 不直接操作数据库。
4. Plugin 先确定业务范围，Action 再在 Plugin 内筛选 Function；不做全局 `query/create` 扩散。
5. 结构化上下文是每个会话的实时状态，模型每轮只接收当前消息和结构化上下文，不接收原始历史消息。
6. 模型只提供候选选择建议，授权、策略、确认和能力检查仍由 Runtime 最终决定。

## 结果

用户创建工单后询问工单编号，模型可以从已验证事实直接回答；转人工后询问排队位置，路由继续使用人工服务范围；服务重启后通过同一 `sessionId` 恢复上下文；外部系统可以仅实现 SPI 并替换 SQLite。
