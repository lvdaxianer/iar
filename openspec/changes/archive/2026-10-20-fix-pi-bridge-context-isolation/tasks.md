# Tasks

## 1. 扩展 API 与展示隔离

- [x] 1.1 将 Pi 扩展的 IAR 结果展示从 `sendMessage` 改为 `appendEntry`，注册 `iar-bridge` entry renderer，并保持 Pi runtime 零依赖；通过类型检查和扩展注册测试验证 API 可用。
- [x] 1.2 为 entry 数据增加控制字符清理、长度上限和纯文本渲染组件；通过边界测试验证超长/异常文本不会进入模型上下文且不会抛出未处理异常。

## 2. 回归测试与文档

- [x] 2.1 更新 Pi bridge 集成测试，断言 handled/confirm 结果进入 display-only entries、pass-through 不创建 entry，且 fake Pi API 不再需要 `sendMessage`；通过定向测试验证会话和故障降级行为未变。
- [x] 2.2 更新 Pi 安装说明、会话边界说明和桥接设计文档，明确 IAR 结果不进入 Pi LLM context；通过文档搜索确认不存在将 `sendMessage` 描述为 display-only 的旧说明。

## 3. 验证与交付

- [x] 3.1 执行 OpenSpec 校验、定向集成测试、类型检查和全量测试，并记录结果；所有命令成功后再提交。
- [x] 3.2 完成代码审查、每任务审计并将变更提交到 bugfix 分支；通过 `git diff --check`、工作区状态和提交内容检查确认无越界修改。

## Workflow follow-up

- Archive the change after review and verification are complete.
- Merge the bugfix branch into the integration branch `master`.
- Re-run final verification on the integrated `master` checkout.
