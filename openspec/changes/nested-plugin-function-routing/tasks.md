# Tasks

## 1. 路由契约与工具校验

- [x] 1.1 定义 `iar.nested-function-call/v1` 内部提案、嵌套 Plugin tool、Function/Operation 候选和具名 `arguments` 类型，并为合法工具名、描述长度和 Schema 子集增加失败优先测试；验证 `npm test -- --runInBand tests/routing/nested-plugin-function-routing.test.ts` 通过。
- [x] 1.2 在 PluginHost 注册边界校验 Plugin、Function、Operation 的所有权、输入/输出 Schema 和工具名称冲突；验证自定义 Plugin 的非法输入/输出在启动校验中被拒绝，合法注册可生成稳定映射。

## 2. 嵌套 Plugin 工具投影

- [x] 2.1 将每个启用 Plugin 投影为一个符合 OpenAI `tools` 约束的工具，并以嵌套结构携带当前 Function/Operation 候选；验证禁用 Plugin 不进入工具、重复归一化名称被拒绝、10 Plugin/28 Operation 映射完整。
- [x] 2.2 保留旧平面 `functionTools(pluginId)` 兼容接口并标记迁移边界；验证现有 PluginHost 和 scoped routing 测试不回归。

## 3. 一次模型调用与 Function Calling 传输

- [ ] 3.1 增加 nested tool adapter，将模型 tool call 解析为 Plugin、Function、Operation 和命名 JSON 参数，并使用 `thinking.type=disabled`；验证正常 provider、无 tool call、非法 JSON、未知工具和超时均有稳定结果。
- [ ] 3.2 让模型网关按统一 normal interaction model 发送一次 nested proposal，保留 JEV/Intent Model 显式兼容回退；验证一次请求不会重复调用 Plugin/Function 选择模型，并记录模型角色和耗时。

## 4. Sandbox 主路由与运行时执行

- [ ] 4.1 替换 Sandbox 主路由为 nested proposal → 运行时所有权/Schema/授权/策略/确认校验 → Function 执行；验证 query/create/update/self-introduction 的 Plugin 与 Function 归属正确，参数错位不会执行。
- [ ] 4.2 按统一 response contract 处理 query 的 `response.generate`、确认/表单的 `none`、允许的 direct 结果和失败错误；验证查询结果交给模型汇总且动作确认不伪造聊天回复。

## 5. 观测、兼容和回归测试

- [ ] 5.1 为 nested route 增加 traceId、阶段耗时、模型调用次数和超时分类的日志/Timing 输出；验证日志不包含 prompt、response、token 或 API key，前端仍显示总耗时与 traceId。
- [ ] 5.2 增加 1/5/10/20/40 Plugin 规模基准和 20 组参数位置准确性测试；验证请求规模、TTFB、总耗时、成功率和参数正确率可复现记录。

## 6. 文档与配置迁移

- [ ] 6.1 更新模型、Plugin、Function Calling 和兼容开关文档，说明 OpenAI tool 名称及 Schema 限制；验证文档命令和 `.env.example` 配置保持一致且不包含密钥。
- [ ] 6.2 增加启动时自定义 Plugin input/output contract 检查的运维说明；验证缺少必需配置或非法契约时错误可定位且不静默回退到 mock provider。

## 7. 集成验证

- [ ] 7.1 运行受影响包的 build、lint、单元测试、集成测试和 OpenSpec strict validation；验证 JEV 已配置、JEV 未配置、Intent fallback、provider 超时、确认恢复和 session follow-up 场景。
- [ ] 7.2 完成全量回归、计划一致性审计、code-review-spec、logging-boundaries 和 backend-reliability 检查，并归档 OpenSpec 变更；验证 `master` 包含所有任务提交且工作树干净。

## Workflow follow-up

- 每个任务通过 focused test、broader verification、代码审查和 per-task audit 后，单独提交并合并回 `master`。
- 所有实现完成后执行 `openspec validate nested-plugin-function-routing --strict`，再按项目流程归档变更。
