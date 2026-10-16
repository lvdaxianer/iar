# Phase 3 Task 3.4 实现计划

## Task boundary and dispatch

- 模块：`examples/knowledge-query/`、`examples/ticket-create/`、`examples/human-transfer/`，以及 `tests/contract/examples/**`。
- 责任：提供三个可安装的 Function Plugin Manifest 和确定性 SDK Handler，验证输入/输出 Schema、Function 归属、能力声明、风险和 confirmation policy 一致。
- 允许修改：三个 examples 目录、`tests/contract/examples/**`、本任务计划/审计和 OpenSpec checklist。
- 依赖：现有 `@iar/contracts`、`@iar/plugin-sdk`、`PluginHost`；不改变路由、Policy、Workflow、Fastify 或真实外部 API。
- 排除范围：真实知识库、工单系统、人工作业队列、网络请求、模型调用和跨插件编排。
- RED：先添加三个 manifest/handler contract tests，验证安装、Function ownership、输入拒绝、输出 Schema、capability/policy consistency 和无外部副作用。
- 聚焦验证：`npm test -- --run tests/contract/examples`。
- 广度验证：`npm run lint && npm run build && npm test`。

## Design decisions

1. 每个示例导出单独的 `PluginRegistration`，Manifest 只声明一个 Function ID，Handler 不读取宿主注册表或动态扩展 capability。
2. Handler 只接收 JSON 输入并返回确定性 JSON；错误输出使用稳定 example error code，不回显原始输入。
3. knowledge query 是低风险只读能力；ticket create 和 human transfer 是高风险写入/转交能力，必须声明 confirmation policy 和对应 capability。
4. contract tests 通过 Ajv/PluginHost 共同验证 Manifest，避免只测静态字段而漏掉真实安装和 Function ownership 约束。
