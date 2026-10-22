# Tasks

## 1. 路由契约与安全阻断

- [x] 1.1 在 `packages/runtime` 和 Sandbox 路由输入构造边界中实现外层 `operation` 单一来源、重复字段冲突校验和稳定 reasonCode；任务边界仅覆盖路由契约类型、提案校验、工具/提示词契约及对应单元/集成测试，不改日志格式和前端展示；验证 `operation_missing`、`operation_not_allowed`、`operation_conflict`、合法注入和“失败不执行 Handler”测试全部通过。

## 2. 可观测日志与宿主诊断

- [x] 2.1 在 `safe-log`、turn failure/timing 结果和 Sandbox/Pi host 诊断展示中增加双语契约错误日志与安全 expected/actual 字段；任务边界仅覆盖日志白名单、reasonCode 传递、Trace 关联和可选 UI 展示，不重新设计路由算法；验证 JSON/pretty 日志、敏感字段排除、Trace 展示和旧成功响应兼容测试通过。

## 3. 端到端稳定性验证

- [x] 3.1 执行 OpenSpec 严格校验、相关包测试、构建和重复请求回归，确认合法请求保持原行为、非法提案均被分类阻断、日志可通过 Trace 关联到阶段耗时；验证所有命令退出码为 0 且记录 20 次重复请求的成功/失败分类与耗时证据。

## Workflow follow-up

- 完成每个任务的 RED/GREEN、代码审查、领域审计和原子提交后，合并回 `master`。
- 所有任务完成后执行最终审计并归档 `fix-route-contract-intermittency`。
