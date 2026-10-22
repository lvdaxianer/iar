# Pi Host 页面可观测性设计

## 目标

修复 Pi Host 的 GFM 表格显示，提供脱敏结构化上下文复制，并只在最终 `response.generate` 阶段展示模型原生 reasoning。语义抽取和路由模型仍不展示 reasoning。

## 设计结论

- Markdown 继续使用现有安全渲染器，只增加有限 GFM 表格解析，不引入第三方依赖。
- 复制按钮复制 `iar.pi-host-context/v1` JSON，内容来自页面当前已知的 route、timing、pending、session 和最近事件；不含密钥、提示词、模型原始载荷、Action input 或 reasoning。
- Bridge 增加流式输入事件，分别传递 `reasoningDelta`、答案 `delta`、timing 和终态；非流式接口保持兼容。
- Pi Host 在 reasoning 到达时创建展开的原始文本区，首个答案增量到达时自动收起；最终正文按 Markdown 渲染。

## 验收标准

1. 合法 GFM 表格显示为表格，恶意 HTML 仍按文本显示。
2. 点击复制按钮得到格式化 JSON，复制失败有明确反馈。
3. 最终回复模型有 reasoning 时显示原始 reasoning；无 reasoning 时不显示空区域。
4. `semantic.extract` 和路由阶段不发送或显示 reasoning。
5. 流式断开、旧 Bridge、非流式替身仍有安全回退。
