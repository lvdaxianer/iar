# Design

## Context

当前 Pi Host 页面由服务端拼装为自包含 HTML，Markdown 使用项目自有的受限渲染器。渲染器在替换 `innerHTML` 前会做 HTML 转义，但只支持标题、列表、段落、行内代码和代码块。8788 Pi Host 通过非流式 Bridge `input` 接收 IAR 终态，Bridge 公开响应只有完整回复和耗时，因此最终 IAR `response.generate` 的 reasoning 无法到达页面。页面现有路由、耗时、Trace、确认和最近事件已经足以组成一个不含权限的调试快照。

## Goals / Non-Goals

**Goals:**

- 安全渲染当前模型常用的 GFM 表格。
- 在页面复制版本化、可读的当前会话结构化调试快照。
- 让最终 `response.generate` 的原生 reasoning 和答案通过独立流事件到达 Pi Host。
- reasoning 到达时展开，首个答案增量到达后自动收起；最终正文继续安全 Markdown 渲染。
- 保持抽取和路由阶段不展示 reasoning，保持日志不写入 reasoning、prompt 和完整答案。

**Non-Goals:**

- 不引入完整 Markdown 第三方解析器或改变其他页面的 Markdown 语法范围。
- 不把 API Key、提示词、原始模型 JSON、Action input 或执行权限复制到剪贴板。
- 不把 reasoning 持久化到会话事实、普通日志或最终回复正文。
- 不改变 Function/Plugin 路由、确认和执行策略。

## Decisions

### 1. 使用受限的 GFM 表格解析

在现有逐行渲染器中识别“表头行 + 分隔行 + 数据行”的有限表格语法，输出 `<table>`、`<thead>`、`<tbody>` 和转义后的 `<th>/<td>`。表格外包裹横向滚动容器；不识别的管线文本继续按普通段落显示。

相比新增 Markdown 依赖，这保持页面自包含、减小供应链和 XSS 面，且只补齐当前响应需要的语法。表格单元格复用已有行内 Markdown转义路径，不接受原始 HTML。

### 2. 复制页面已知的安全快照

前端维护最新的 route、timing、pending、session 和最近事件投影。复制按钮将这些字段组装为 `iar.pi-host-context/v1` JSON，并使用 Clipboard API；失败时显示局部错误，不影响聊天。快照不包含聊天正文、原始 reasoning、提示词或模型载荷，避免把调试按钮变成数据外泄入口。

相比新增公开上下文 API，这个方案不扩大 Bridge 的数据面，也能准确复制页面当前实际看到的证据。后续若需要完整 BehaviorContext，可单独设计受控导出契约。

### 3. Bridge 增加独立的流式输入通道

新增 Bridge 流式输入端点，复用现有会话 `turnStreamed` 的阶段、reasoning、答案、timing 和终态事件；非流式 `input` 保持兼容。Pi Bridge client 增加可选的 `inputStream`，Pi Host 使用它，测试替身没有该能力时回退到现有 `input`。

Pi Host 会话把 reasoning 和答案增量映射成独立 SSE 事件。IAR entry 仍负责最终 disposition 和元数据；当答案已经流过页面时，entry 只负责收尾，避免答案重复显示。pass-through 仍按原流程交给 Pi Agent。

### 4. reasoning 只对最终回复生效

运行时已有流式回复回调和 `semantic.extract` 的 thinking disabled 约束。Bridge 只转发流式事件，不改变模型原始 reasoning。页面用 `<details open>` 和 `<pre>` 原样展示 reasoning；收到首个 answer delta 后设置 `open=false`。没有 reasoning 时不创建空面板。

## Risks / Trade-offs

- [Risk] 上游只返回答案、不返回 reasoning。→ 不创建 reasoning 面板，正常显示答案并保留能力状态。
- [Risk] 流式连接中断时只收到部分 reasoning 或答案。→ 发送稳定错误和 timing；页面不把未完成内容标记为成功，沿用现有失败提示。
- [Risk] 表格单元格含超长或恶意文本。→ 使用现有长度边界和 HTML 转义，并在 CSS 中允许横向滚动。
- [Risk] 用户复制到外部工具后可能把内部路由信息分享出去。→ 快照只含页面已公开的非权威摘要，并在按钮旁说明“脱敏快照”。

## Migration Plan

先更新共享渲染器和页面测试，再更新 Bridge 协议和 Pi Host 流式适配，最后接入按钮和端到端回归。旧客户端继续调用非流式 `input`，旧 Bridge 不支持流式时 Pi Host 自动回退，不需要数据迁移。若新流式端点出现问题，可关闭 Pi Host 流式能力并继续使用旧非流式路径。
