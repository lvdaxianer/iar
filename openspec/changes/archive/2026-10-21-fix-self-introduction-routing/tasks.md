# Tasks

## 1. Prompt 与自我介绍路由

- [x] 1.1 为启用自我介绍 Plugin 的身份/能力询问增加真实 Prompt 回归测试，并验证现状会错误返回 `unknown`。
- [x] 1.2 修改语义 Prompt，使身份/能力介绍请求在候选存在时选择自我介绍 Function，同时保留普通寒暄的 `unknown` 行为；通过结构化 Prompt 测试验证。
- [x] 1.3 验证自我介绍命中后仍使用现有 Plugin 执行、能力汇总和额外提示词生成链路；通过 Agent 集成测试验证。

## 2. Agent 级 Plugin 开关

- [x] 2.1 增加默认开启和显式关闭内置自我介绍 Plugin 的 Runtime 测试，并验证关闭后不出现在 Host descriptors。
- [x] 2.2 修改 Runtime 筛选逻辑，使内置自我介绍默认加入但尊重 `disabledPluginIds`；通过 Runtime 和 sandbox 集成测试验证。
- [x] 2.3 验证关闭的外部 Plugin 与内置 Plugin 都不会进入语义/路由候选或自我介绍清单；通过作用域路由测试验证。

## 3. 基础能力上下文

- [x] 3.1 增加未命中路由时向 Pi Agent 传递当前启用能力目录的回归测试，并验证关闭能力不被传递。
- [x] 3.2 修改 Pi 兜底输入构造，向模型提供有界、标记为数据的当前能力目录；通过 scripted 与注入委托测试验证。
- [x] 3.3 扩展 pass-through Bridge 响应并让 Pi Host 使用该上下文；通过 Pi bridge/host 集成测试验证旧响应仍兼容。
- [x] 3.4 运行构建、聚焦测试、全量测试、lint 和 OpenSpec 严格校验，记录审查结果并完成任务审计。

## Workflow follow-up

- 完成 code-review-spec、backend-reliability 和 verification gates。
- 提交任务变更并合并回 `master`。
- 归档 OpenSpec change 并验证归档结果。
