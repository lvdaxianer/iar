# Tasks

## 1. Markdown 安全渲染

- [x] 1.1 在共享受限 Markdown 渲染器中增加有限 GFM 表格解析，保留 HTML 转义、表格容器滚动和未知语法降级行为；用渲染回归测试验证表头、数据行、行内代码和恶意 HTML。

## 2. 结构化上下文复制

- [ ] 2.1 在 Pi Host 页面维护版本化脱敏快照并增加复制按钮、成功/失败反馈和键盘可用状态；用页面交互测试验证最新 route/timing/pending/events 被复制且不含敏感字段。

## 3. 最终回复原生思考流

- [ ] 3.1 扩展 Bridge 流式输入协议、client 校验和服务器事件转发，确保 reasoning/answer/timing/done 顺序稳定并兼容旧非流式调用；用协议和流式回归测试验证超时、断流和无 reasoning。
- [ ] 3.2 在 Pi Host 会话与前端接收最终 `response.generate` 的 reasoning/answer 事件，思考展开、首个答案增量后收起、终态不重复；用会话和浏览器脚本测试验证抽取阶段不展示 reasoning。

## 4. 集成验证

- [ ] 4.1 运行 OpenSpec 严格校验、项目类型检查、全量测试和 Pi Host 演示构建，并检查工作区 diff 只包含本变更范围。

## Workflow follow-up

- 完成每个任务的代码审查、TDD 红绿重构、审计和提交后，将任务分支合并回 `master`。
- 全部任务完成后归档 `pi-host-ui-context` OpenSpec 变更并验证集成分支。
