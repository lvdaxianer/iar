# 文档索引

当前文档按“架构方案、实现审计、参考资料”分层维护：

- [架构技术方案](./架构技术方案/README.md)：当前架构主文档，内容以源码实现为准。
- [实现对齐矩阵](./架构技术方案/实现对齐矩阵.md)：架构结论、状态边界与源码入口的逐项映射。
- [参考资料](./架构技术方案/references/)：Manifest、路由、压缩提示词和其他示例。
- [方案计划](./架构技术方案/plans/)：实施计划与历史方案记录。
- [设计规格](./架构技术方案/specs/)：阶段性设计规格与历史决策记录。
- [实现审计](./implementation-audits/)：实现过程审计，不作为当前架构主方案。
- [Runtime 包迁移](./runtime-package-migration.md)：最终包树、Pi/持久化/adapter 边界和旧包迁移表。

当前包边界：`contracts`、`plugin`、`plugins`、`runtime`、`storage`、`subscriptions`、`control-plane` 和 `cli` 为核心包；`adapters/*` 保持独立适配器，其中 `pi` 发布为 `@iar/pi-bridge`。Decision、Rule Engine、Workflow、Observability 和 Agent 已收敛到 `@iar/runtime` 内部或其公共导出。`examples/agent-sandbox` 是根级组合根，插件示例统一位于 `examples/plugins/`，examples 不参与 workspace package 发布。

维护规则：运行时行为、契约和状态结构发生变化时，先更新代码与测试，再同步更新 `架构技术方案/README.md` 和 `架构技术方案/实现对齐矩阵.md`。根索引只负责导航，不复制架构正文。
