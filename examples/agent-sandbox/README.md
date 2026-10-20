# IAR Agent Sandbox

可交互的 IAR 插件沙盒示例：在网页输入一句话，后端走完「语义抽取 → 两阶段路由 → 策略/确认 → 插件执行 → 回复生成」全链路，右侧调试面板实时展示路由证据、事件流和 BehaviorContext，并支持显式触发上下文压缩。

当前沙盒模拟一个**企业数据平台**，共 **10 个子系统 = 10 个 Function**：每个 Function 对应一个本地插件（确定性 fixture，无真实副作用），并挂一个本地中文知识库（概念解释、操作步骤、常见问题、排错指南）。

| Function | 子系统 | 操作（read 免确认 / action 需确认） |
| --- | --- | --- |
| `knowledge.query` | 平台通用知识 | read: search（知识检索） |
| `dip.manage` | 数据集成管理 | read: list/detail；action: rerun/stop |
| `job.monitor` | 任务调度监控 | read: status/logs |
| `api.gateway` | API 网关管理 | read: stats；action: limit |
| `dataset.query` | 数据资产目录 | read: search/lineage |
| `report.center` | 报表中心 | read: list；action: export |
| `system.status` | 系统状态与告警 | read: overview/alerts |
| `account.privilege` | 账户与权限 | read: mine；action: grant |
| `ticket.create` | 工单支持 | read: progress；action: create |
| `human.transfer` | 人工服务 | action: transfer |

## 运行

```bash
npm install
npm run demo:sandbox
```

启动后访问终端打印的地址（默认 `http://localhost:8787`）。

也可以使用 pnpm。pnpm workspace 已配置为链接仓库内的私有 `@iar/*` 包，运行脚本不会隐式联网安装；首次使用或依赖变更后先显式执行安装：

```bash
pnpm install
pnpm run demo:sandbox
```

如果出现“端口已被占用”，先确认监听进程，再结束自己启动的旧 sandbox；也可以直接换端口：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
IAR_SANDBOX_PORT=8788 npm run demo:sandbox
```

启动器会将端口冲突记录为 `port_in_use`，不会输出原始异常或敏感配置。

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
| `IAR_PERSISTENCE_PROVIDER` | 会话 Provider 标识；默认内置 `sqlite` | `sqlite` |
| `IAR_PERSISTENCE_MODULE` | 外部 Provider 的动态模块入口 | 无（内置 Provider 不需要） |
| `IAR_PERSISTENCE_OPTIONS_JSON` | 传给 Provider 的 JSON 对象 | 无 |
| `IAR_SANDBOX_SQLITE_PATH` | 内置 SQLite 文件路径 | `./data/iar-sandbox.sqlite` |

## 会话恢复与 Provider

每个 `POST /api/sessions` 都会返回 32 位随机 `sessionId`。请求使用 `/api/sessions/{sessionId}/...`，服务重启后先调用 `POST /api/sessions/{sessionId}/resume`，恢复完成后再继续聊天、确认或压缩。默认内置 SQLite Provider 异步保存消息、事件和结构化上下文快照；外部 Provider 只需实现 `@iar/storage` 并通过上表的三个 Provider 变量接入。

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

- 左侧：对话区，用户/助手气泡；高风险动作（action 操作）会弹出「确认执行 / 取消」按钮。
- 右侧调试面板：当前 Function/Plugin 与路由状态、10 个子系统清单、最近事件列表、BehaviorContext JSON 视图、上下文压缩按钮（显示哈希变化与摘要）、重置按钮。

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

- **brain 模式**：先用 Response Generator 生成兜底回复，输入包含用户消息、最近对话、可用功能（10 个子系统的 functionId）和未命中原因码；提示词要求基于对话历史自然回答（如「你是谁呢」→ 自我介绍为 IAR Agent Sandbox；「我刚才让你干啥来着」→ 根据历史回答），或自然解释能做什么。只有生成失败才回退固定话术。
- **scripted 模式**：轻量模板兜底，覆盖「你是谁 / 你能做什么（十项能力）/ 我刚才让你做什么（基于最近对话的关键词回忆）」，模板覆盖不了再回退固定话术。

另外，brain 模式下语义抽取失败时会自动用离线 `ScriptedModelProvider` 重试一次，成功则继续走正常链路，并在路由证据里标注 `semanticFallback: true`；重试仍失败才返回错误回复。

## 确认策略

- 每个插件的 Manifest policy 统一声明 `riskLevel: high` + `requiresConfirmation: true` 作为**安全上限**。
- session 按操作的 kind 收敛实际策略：read 操作降为 low + 免确认直接执行；action 操作沿用 manifest 上限（high + 需确认，走 `/api/confirm` 确认流）。manifest policy 不可被放宽。
- `operation` 缺省时由 handler 端按 query 关键词推断默认 read 操作。

## 目录结构

```
examples/agent-sandbox/
├── config/models.brain.json      # 模型 profile 配置（本示例无需改动）
├── src/
│   ├── session.ts                # 会话组合根：安装 10 个插件、确认策略、兜底回复
│   ├── rules.ts                  # 10 组 FunctionRule / PluginRule（semantic.intent equals）
│   ├── server.ts                 # Fastify 宿主（/api/chat、/api/confirm、/api/compact、/api/state、/api/reset）
│   ├── env.ts                    # .env 加载
│   ├── functions/                # 10 个子系统插件（每个文件 export manifest + handler + 注册对象）
│   │   ├── common.ts             # 统一输入解析 / 输出信封 / 操作类型
│   │   ├── index.ts              # allSandboxPlugins + 能力清单元数据（sandboxFunctionCatalog）
│   │   ├── knowledge-query.ts    # 平台通用知识（knowledge.query / knowledge-query-v1）
│   │   ├── dip-manage.ts         # 数据集成管理（dip.manage / dip-manage-v1）
│   │   ├── job-monitor.ts        # 任务调度监控（job.monitor / job-monitor-v1）
│   │   ├── api-gateway.ts        # API 网关管理（api.gateway / api-gateway-v1）
│   │   ├── dataset-query.ts      # 数据资产目录（dataset.query / dataset-query-v1）
│   │   ├── report-center.ts      # 报表中心（report.center / report-center-v1）
│   │   ├── system-status.ts      # 系统状态与告警（system.status / system-status-v1）
│   │   ├── account-privilege.ts  # 账户与权限（account.privilege / account-privilege-v1）
│   │   ├── ticket-create.ts      # 工单支持（ticket.create / ticket-create-v1）
│   │   └── human-transfer.ts     # 人工服务（human.transfer / human-transfer-v1）
│   ├── knowledge/
│   │   ├── retrieval.ts          # 知识库加载（构造期校验）与确定性检索（字二元组 + 加权评分）
│   │   └── bases/<functionId>.json ×10  # 每个子系统一个本地中文知识库（≥10 条）
│   ├── models/                   # brain 真实 LLM provider / scripted 离线假大脑
│   └── execution/                # worker 线程插件执行桥与注册表
└── web/index.html                # 单文件聊天与调试面板
```

## 试试这些输入

- `如何申请数据权限` → 路由到 `knowledge.query`，知识检索直接执行。
- `重跑订单同步这个 DIP` → 路由到 `dip.manage` 的 rerun，高风险需确认后执行。
- `订单汇总 Job 跑完了吗` → 路由到 `job.monitor`，read 直接执行。
- `搜一下用户表` → 路由到 `dataset.query`，返回带相关度的资产检索结果。
- `导出销售日报` → 路由到 `report.center` 的 export，高风险需确认后执行。
- `现在有哪些告警` → 路由到 `system.status`，read 直接执行。
- `帮我提个工单，网络很卡` → 路由到 `ticket.create`，高风险需确认后执行。
- `转人工` → 路由到 `human.transfer`，高风险需确认后执行。
- `你是谁呢` → 路由未命中，兜底回复介绍 10 个子系统。

## 说明

- 十个插件全部在 `examples/agent-sandbox/src/functions/` 内实现，本地确定性 fixture，不产生真实副作用；search 类操作从本 Function 的本地知识库检索 top3。
- 知识库 JSON 在 session 构造时全量预加载，文件缺失、JSON 非法或结构不合规都会以带 functionId 的清晰错误终止启动。
- LocalWorkflow 的 ActionExecutor 是同步签名，插件 Handler 的异步执行通过 `src/execution/` 下的 worker 线程桥完成。
- 本示例不设测试，编译验证依赖根目录 `npm run build`。
