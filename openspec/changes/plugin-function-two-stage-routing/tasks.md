# Tasks

## 1. Function Calling 公共契约与模型传输

- [x] 1.1 增加 `iar.function-call/v1` 输入/输出类型、Schema、稳定验证错误和 `function.call` ModelRole。
- [x] 1.2 增加 OpenAI-compatible `tools`/`tool_choice` 请求边界以及原生 tool call / JSON fallback 解析。
- [x] 1.3 增加 JEV primary、Intent Model fallback 和缺失 JEV 时不走 mock 的模型配置解析测试。

## 2. Plugin-first 候选与两阶段路由

- [x] 2.1 增加 Plugin 级候选描述与 Function 工具描述投影，保证禁用/系统 Plugin 不进入候选。
- [x] 2.2 扩展 semantic frame 的 Plugin proposal，并移除新主路径第一阶段的全量 Function 描述。
- [x] 2.3 改造 `PluginFirstRouter`：验证 Plugin proposal，加载选中 Plugin 的 Function 集合，执行 `function.call`，并复用 ownership/authorization/capability 门禁。

## 3. Sandbox 执行与回复集成

- [ ] 3.1 将 session routing 接入新的 Function Calling adapter，并把模型提出的 arguments 作为唯一 Action 输入来源。
- [ ] 3.2 保持 query/read 和 self-introduction 的结果进入 `response.generate`，confirmation/form/UI-only 继续跳过回复模型。
- [ ] 3.3 更新 DeepSeek/JEV/Intent profile、提示词、离线 provider 和相关文档，保留旧 profile 兼容。

## 4. Verification and audit

- [ ] 4.1 覆盖 Plugin proposal、单/多 Function、错误参数、ownership mismatch、禁用 Plugin、JEV fallback、query 汇总和 side-effect confirmation。
- [ ] 4.2 运行 focused tests、`npm run build`、完整 `npm test` 和 `openspec validate plugin-function-two-stage-routing --strict`。
- [ ] 4.3 完成后端可靠性、日志边界、代码审查和计划一致性审计，逐项提交并合并回 `master`，归档 OpenSpec change。

## Workflow follow-up

- 每个任务在 RED/GREEN、代码审查、专项审计和提交后再进入下一个任务。
- 最终报告必须列出已完成任务、未完成任务、验证证据和集成分支状态。
