# Tasks

## 1. 固定 Function 响应契约

- [x] 1.1 增加版本化 `FunctionResponse` 类型和 Schema，覆盖 `model`、`direct`、`none` 及字段边界。
- [x] 1.2 扩展 Handler 结果契约并迁移内置/示例 Plugin 的合法输出。
- [x] 1.3 增加契约测试，验证未知模式、缺失 direct 文本、none 携带文本和超限字段均 fail-closed。

## 2. 启动与执行校验

- [x] 2.1 在 Plugin 安装准备阶段编译并校验 Function 输入/输出 Schema 与响应契约，验证任一失败不会写入部分注册状态。
- [x] 2.2 在执行桥调用前后校验真实输入、业务输出和响应信封，返回稳定 Action 失败。
- [x] 2.3 增加自定义 Plugin 启动校验和运行时非法输出回归测试。

## 3. 回复模型分流

- [x] 3.1 普通执行路径按 `model/direct/none` 分流，并让 self-introduction 使用模型汇总。
- [x] 3.2 流式执行路径复用同一分流规则，保证 direct/none 不意外调用回复模型。
- [x] 3.3 为模型上下文标记已校验输出为数据，禁止响应结果改变执行权限或路由。

## 4. 验证与交付

- [x] 4.1 运行聚焦测试、lint、build、全量测试和 OpenSpec 严格校验。
- [x] 4.2 完成代码审查、可靠性审查和任务审计，提交并合并到 `master`。
- [x] 4.3 归档 OpenSpec change，并在合并后的主工作区复验。
