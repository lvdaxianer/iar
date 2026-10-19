# Tasks

## 1. 通用事实与澄清上下文

- [x] 1.1 扩展通用事实信封、响应澄清元数据和 BehaviorContext pending 契约；更新插件输出、事件投影、压缩/SQLite 快照与模型提示词，使插件显式声明的任意 bounded primitive facts 和有限澄清选项可在普通/流式路径中被后续模型使用；以失败测试先行覆盖事实追问、数字选项、非法元数据、压缩恢复、SQLite 恢复和多会话隔离，并在同一任务中更新 `docs/README.md` 技术方案，最后运行定向测试、完整测试、构建、OpenSpec 严格校验和变更审查。

## Workflow follow-up

- 完成实现、测试和审查后同步变更到主规范。
- 归档 `generic-structured-clarification` OpenSpec change，并验证归档结果。
