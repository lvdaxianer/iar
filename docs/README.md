# 文档索引

当前文档按“架构方案、参考资料、过程记录”分层维护：

## 架构方案（当前事实）

- [架构技术方案](./架构技术方案/README.md)：当前架构主文档，内容以源码实现为准。
- [实现对齐矩阵](./架构技术方案/实现对齐矩阵.md)：架构结论、状态边界与源码入口的逐项映射。

## 使用参考

- [定义 Function](defining-functions.md)：Function 契约、与 Plugin 的关系、新增 Function 的四步与检查清单。
- [定义 Plugin](defining-plugins.md)：Manifest 逐字段详解、Handler 契约、可信事实声明、从注册到执行的完整链路。
- [Nested Plugin Function Calling](nested-plugin-function-calling.md)：OpenAI tool 格式、一次路由、参数校验与自定义 Plugin 启动检查。
- [插件函数架构](plugin-function-architecture.md)：Plugin/Function 分层架构说明。
- [统一入口](unified-entry.md)：统一调用入口与组合方式。
- [Runtime 包迁移](runtime-package-migration.md)：最终包树、Pi/持久化/adapter 边界和旧包迁移表。
- [包发布](package-publishing.md)：workspace 包发布与 `verify:packages` 校验流程。

## 测试用例集

- [Agent Sandbox 上下文追问测试用例](agent-sandbox-test-cases.md)
- [Agent Sandbox 反问补全测试用例](agent-sandbox-clarification-test-cases.md)
- [Agent Sandbox 澄清阶梯测试用例](agent-sandbox-clarification-ladder-test-cases.md)
- [Agent Sandbox 话题切换测试用例](agent-sandbox-topic-switch-test-cases.md)
- [Agent Sandbox 疑难场景测试用例](agent-sandbox-tricky-test-cases.md)

## 过程记录（历史档案，不代表当前事实）

- [架构技术方案/references/](./架构技术方案/references/)：Manifest、路由、压缩提示词和其他示例，主文档仍引用其中材料。
- [架构技术方案/plans/](./架构技术方案/plans/)：实施计划与历史方案记录。
- [架构技术方案/specs/](./架构技术方案/specs/)：阶段性设计规格与历史决策记录。
- [实现审计](./implementation-audits/)：实现过程审计，不作为当前架构主方案。
- [superpowers/](./superpowers/)：superpowers 工作流产生的 plans/results/specs，与实现审计同属历史档案。
- [performance/](./performance/)：真实模型耗时基线记录，新基线按同格式追加。

## 归档与退役规则

- 运行时行为、契约和状态结构发生变化时，先更新代码与测试，再同步更新 `架构技术方案/README.md` 和 `架构技术方案/实现对齐矩阵.md`。根索引只负责导航，不复制架构正文。
- `implementation-audits/` 与 `superpowers/` 只增不改：对应任务合入 master 后，只补最终结论，不再回头修订过程正文。
- OpenSpec 变更在实现评审通过后必须执行归档（`openspec archive`），归档后的 proposal/design/tasks 不再修订；当前有效变更只存在于 `openspec/changes/` 根级。
- 历史方案若被新方案取代，在本文档对应条目注明取代关系，不删除原文。

当前包边界：`contracts`、`plugin`、`plugins`、`runtime`、`storage`、`subscriptions`、`control-plane` 和 `cli` 为核心包；`adapters/*` 保持独立适配器，其中 `pi` 发布为 `@iar/pi-bridge`。Decision、Rule Engine、Workflow、Observability 和 Agent 已收敛到 `@iar/runtime` 内部或其公共导出。`examples/agent-sandbox` 是根级组合根，插件示例统一位于 `examples/plugins/`，examples 不参与 workspace package 发布。
