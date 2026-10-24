# Tasks

## 1. Bridge 安全状态协议与投影

- [x] 1.1 为 Bridge state 增加可选的 `structuredContext` 与 `workflowState` 安全契约、客户端校验及旧响应兼容测试；验证 `npm test -- tests/integration/pi-bridge/client.test.ts` 通过。
- [x] 1.2 从权威 `BehaviorContext` 和 Workflow 投影生成 Bridge state，保留有界事实/轮次元数据并过滤原始消息、槽位值、Action input、凭据和确认授权字段；补充 state 路由测试并验证 `npm test -- tests/integration/pi-bridge` 通过。

## 2. Pi Host 状态同步与复制快照

- [x] 2.1 让 PiHostSession 在输入、确认/取消和重连后同步最新 Bridge state，并通过现有 SSE 通道发送状态；验证 `npm test -- tests/integration/pi-host/pi-host-session.test.ts` 通过且状态同步失败不改变既有业务处置。
- [ ] 2.2 让页面复制动作导出当前单一会话的 `structuredContext`、`workflowState` 和既有诊断摘要，保留 Runtime 已有的有界逐轮上下文；补充敏感字段回归测试并验证 `npm test -- tests/integration/pi-host/pi-host-page.test.ts` 通过。

## 3. 变更验证与真实链路回归

- [ ] 3.1 完成 OpenSpec 严格校验、全量测试、lint、build 和差异审计，确认未改动业务插件/路由/执行语义；验证 `openspec validate pi-host-turn-context-export --strict`、`npm test`、`npm run lint` 和 `npm run build` 均通过。
- [ ] 3.2 在真实模型端口 `8878` 的同一会话执行用户提供的 50 个话题突变场景，验证复制结果包含多轮结构化上下文与 workflow state，并记录每组结果；失败时先修复非业务性的上下文导出/展示问题再继续回归。

## Workflow follow-up

- 完成所有任务后执行最终审计，归档 OpenSpec change，并将任务分支合并回 `master`。
- 在 `master` 上确认工作树干净、提交祖先关系正确后执行用户要求的 `git push`。
