# Proposal

## Why

Pi Host 当前使用受限 Markdown 渲染器，无法把模型返回的 GFM 表格展示为表格；同时 8788 页面只看到回复和阶段耗时，无法查看最终回复模型的原始思考过程，也缺少可复制的安全结构化上下文。三者都会降低调试结果的可读性和问题定位效率。

## What Changes

- 为共享安全 Markdown 渲染器增加 GFM 表格渲染，并保持 HTML 转义、表格横向滚动和恶意标签防护。
- 为 Pi Host 增加“复制结构化上下文”操作，复制当前会话的脱敏、版本化 JSON 快照，不包含密钥、提示词、原始模型载荷或未授权执行对象。
- 为 Bridge 增加仅用于最终 `response.generate` 的原生 reasoning/answer 流式事件。
- Pi Host 在最终回复生成期间实时展示原始 reasoning；正式答案开始输出后自动收起 reasoning，最终答案继续按安全 Markdown 渲染。
- `semantic.extract`、路由选择和其他结构化决策阶段继续关闭 reasoning，页面不展示这些阶段的原始思考内容。
- 增加前后端契约校验、异常收敛和回归测试，确保无 reasoning、断流、复制失败和超长内容仍可恢复。

## Capabilities

### New Capabilities

- `pi-host-structured-context-export`: 提供 Pi Host 当前会话安全结构化上下文的版本化复制能力。

### Modified Capabilities

- `pi-host-entry-rendering`: 增加 GFM 表格安全渲染和复制操作的用户反馈要求。
- `reasoning-stream`: 将原生 reasoning/answer 流延伸到 Pi Host Bridge，并限定只展示最终回复模型。

## Impact

- 前端：`examples/agent-sandbox/web/markdown*.fragment.js`、Pi Host 页面模板与交互脚本、共享样式。
- Bridge：`packages/adapters/pi` 的公开协议、client 校验和 Pi Host 服务器转发。
- 运行时：IAR 流式响应向 Bridge 的事件转发，以及脱敏结构化上下文快照。
- 测试：协议校验、Pi Host 会话事件、Markdown 渲染和复制快照测试。
- 不新增第三方 Markdown 依赖；沿用自包含页面和现有安全渲染边界。
