# IAR Agent Sandbox

可交互的 IAR 插件沙盒示例：在网页输入一句话，后端走完「语义抽取 → 两阶段路由 → 策略/确认 → 插件执行 → 回复生成」全链路，右侧调试面板实时展示路由证据、事件流和 BehaviorContext，并支持显式触发上下文压缩。

## 运行

```bash
npm run demo:sandbox
```

启动后访问终端打印的地址（默认 `http://localhost:8787`）。

## 大脑模式

- `--brain real`：语义抽取、上下文压缩、回复生成走真实 LLM（Moonshot 兼容接口）。
- `--brain scripted`：离线假大脑，关键词匹配，无需任何网络。

不传 `--brain` 时，检测到 `IAR_LLM_API_KEY` 用 real，否则用 scripted。

## 环境变量

密钥不写入任何配置文件，只从环境变量读取；把下面的值写进**仓库根目录的 `.env`** 文件（已被 .gitignore 忽略）即可自动加载，已存在的真实环境变量优先。

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `IAR_LLM_API_KEY` | real 模式的 API Key（兼容 `IAR_MODEL_API_KEY`） | 无 |
| `IAR_LLM_BASE_URL` | OpenAI 兼容接口地址 | `https://api.moonshot.cn/v1` |
| `IAR_LLM_MODEL_ID` | 普通交互模型名称；profile 映射优先使用它 | profile `modelId` |
| `IAR_INTENT_MODEL_ENDPOINT` | Intent Model 独立 OpenAI 兼容接口地址 | 无，缺失时 fail-closed |
| `IAR_INTENT_MODEL_API_KEY` | Intent Model 独立 API Key | 无，缺失时 fail-closed |
| `IAR_INTENT_MODEL_ID` | Intent Model 名称 | profile `modelId` |
| `IAR_SANDBOX_DECISION_BACKEND` | 决策 backend：`jev` 或 `intent-model`；不设置时 JEV 优先 | JEV 优先 |
| `IAR_SANDBOX_PORT` | 服务端口 | `8787` |

## 模型配置

模型配置在 [`config/models.brain.json`](./config/models.brain.json)，每个 profile 的关键字段：

| 字段 | 作用 |
| --- | --- |
| `role` | 模型角色：`semantic.extract` / `context.compact` / `response.generate` 使用普通交互模型；`function.select` / `plugin.select` 同时声明 JEV 和 Intent Model profile |
| `decisionBackend` | 决策 profile 的 backend：`jev` 或 `intent-model`；同时存在时 JEV 固定优先 |
| `provider` | 用哪个 provider：`brain`（普通交互模型）、`intent-model`（Intent Model）或 `mock`（离线确定性决策） |
| `environment` | 非敏感环境变量名映射：`endpoint` / `apiKey` / `modelId`；变量值不写入 JSON |
| `modelId` | profile 内的安全默认模型名；当 `environment.modelId` 指向的变量未设置时使用 |
| `timeoutMs` / `retryPolicy` | 超时与重试；`fallbackProfileId` 指向同角色、同 backend 的兜底 profile |

接口地址、密钥和可变模型名通过 `environment` 映射从环境变量读取，不进配置文件。配置文件里的其他字符串值仍支持 `"${VAR_NAME}"` 环境变量引用（由 IAR 的 `loadModelProfiles` 在加载时解析，引用的变量未设置会启动报错）；IAR 运行时的 `config/models.yaml` 同样支持该写法。

普通模型和 Intent Model 使用同一 OpenAI-compatible `chat/completions` JSON boundary。Intent Model 由 provider 固定注入 `iar.intent-decision-prompt/v1`，输出仍必须是 `iar.decision/v1`，因此切换 backend 不会改变路由结果结构。

没有 API Key 时直接用 `npm run demo:sandbox -- --brain scripted`（或省略参数）即可离线体验。

## 界面说明

- 左侧：对话区，用户/助手气泡；高风险动作会弹出「确认执行 / 取消」按钮。
- 右侧调试面板：当前 Function/Plugin 与路由状态、最近事件列表、BehaviorContext JSON 视图、上下文压缩按钮（显示哈希变化与摘要）、重置按钮。

## 流式输出

`POST /api/chat` 支持 SSE 流式响应：请求体带 `"stream": true` 或查询参数 `?stream=1` 时，响应为 `text/event-stream`，事件按序下发，结束前固定发送 `{"type":"end"}`：

| 事件 | 说明 |
| --- | --- |
| `{ "type": "stage", "stage": "semantic" \| "route" \| "action" \| "response" }` | 阶段进度（正在理解意图/路由/执行插件/生成回复） |
| `{ "type": "delta", "text": "..." }` | 回复增量，仅 response 阶段产生 |
| `{ "type": "done", "result": { ... } }` | 最终 TurnResult，与非流式 `turn()` 返回同构 |
| `{ "type": "error", "reasonCode": "...", "message": "..." }` | 流式处理异常 |

scripted 模式没有真实流，回复阶段会一次性下发 delta 与 done。前端默认优先走流式（fetch + `response.body.getReader()` 逐段解析、逐字渲染），流式不可用（如 5xx）时自动回退原有 JSON 响应。确认按钮（awaiting_confirmation）流程仍走 `/api/confirm`。

## 兜底回复

路由未命中（unknown 意图或需澄清）时不再只回固定话术，而是分层兜底：

- **brain 模式**：先用 Response Generator 生成兜底回复，输入包含用户消息、最近对话、可用功能（`knowledge.query` / `ticket.create` / `human.transfer`）和未命中原因码；提示词要求基于对话历史自然回答（如「你是谁呢」→ 自我介绍为 IAR Agent Sandbox；「我刚才让你干啥来着」→ 根据历史回答），或自然解释能做什么。只有生成失败才回退固定话术。
- **scripted 模式**：轻量模板兜底，覆盖「你是谁 / 你能做什么 / 我刚才让你做什么（基于最近对话的关键词回忆）」，模板覆盖不了再回退固定话术。

另外，brain 模式下语义抽取失败时会自动用离线 `ScriptedModelProvider` 重试一次，成功则继续走正常链路，并在路由证据里标注 `semanticFallback: true`；重试仍失败才返回错误回复。

## 试试这些输入

- `帮我查一下退款政策` → 路由到 `knowledge.query`，低风险直接执行。
- `帮我提个工单，网络很卡` → 路由到 `ticket.create`，高风险需确认后执行。
- `转人工` → 路由到 `human.transfer`，高风险需确认后执行。

## 说明

- 三个示例插件来自 `examples/knowledge-query`、`examples/ticket-create`、`examples/human-transfer`，均为本地确定性 fixture，不产生真实副作用。
- LocalWorkflow 的 ActionExecutor 是同步签名，插件 Handler 的异步执行通过 `src/execution/` 下的 worker 线程桥完成。
- 本示例不设测试，编译验证依赖根目录 `npm run build`。
