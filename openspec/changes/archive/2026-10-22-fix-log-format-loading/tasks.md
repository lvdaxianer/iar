# Tasks

## 1. 修正日志初始化时序

- [x] 1.1 在演示入口加载 `.env` 后再动态导入服务与日志模块，并保留启动失败边界；用 subprocess 回归测试验证 `pretty` 首条日志为中英双语。
- [x] 1.2 将本地 `.env` 的日志格式设为 `pretty`，同步模板和 README 的 JSON/pretty 配置说明；验证配置文档与实际默认行为一致。

## 2. 验证与集成

- [x] 2.1 运行构建、日志专项测试和全量测试，确认耗时日志字段、脱敏与业务行为不回归。
- [x] 2.2 运行 `openspec validate fix-log-format-loading --strict`，完成代码审查、提交并合并回 `master`。

## Workflow follow-up

- Archive the change after implementation and review gates pass.
- Verify the archived change and return to the `master` integration checkout.
