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
| `IAR_SANDBOX_PORT` | 服务端口 | `8787` |

## 模型配置

模型配置在 [`config/models.brain.json`](./config/models.brain.json)，每个 profile 的关键字段：

| 字段 | 作用 |
| --- | --- |
| `role` | 模型角色：`semantic.extract` / `context.compact` / `response.generate` 走真实模型，`function.select` / `plugin.select` 保持 `mock`（确定性决策） |
| `provider` | 用哪个 provider：`brain`（真实 LLM）或 `mock`（假大脑） |
| `modelId` | **实际调用的模型名**。可以直接写模型名，也可以写 `"${IAR_SANDBOX_MODEL}"` 这样的环境变量引用（值从 `.env` 或环境变量解析，六个 brain profile 都要改） |
| `timeoutMs` / `retryPolicy` | 超时与重试；`fallbackProfileId` 指向同角色的兜底 profile |

接口地址和密钥不进配置文件，用上面的环境变量。配置文件里的字符串值都支持 `"${VAR_NAME}"` 环境变量引用（由 IAR 的 `loadModelProfiles` 在加载时解析，引用的变量未设置会启动报错）；IAR 运行时的 `config/models.yaml` 同样支持该写法。

没有 API Key 时直接用 `npm run demo:sandbox -- --brain scripted`（或省略参数）即可离线体验。

## 界面说明

- 左侧：对话区，用户/助手气泡；高风险动作会弹出「确认执行 / 取消」按钮。
- 右侧调试面板：当前 Function/Plugin 与路由状态、最近事件列表、BehaviorContext JSON 视图、上下文压缩按钮（显示哈希变化与摘要）、重置按钮。

## 试试这些输入

- `帮我查一下退款政策` → 路由到 `knowledge.query`，低风险直接执行。
- `帮我提个工单，网络很卡` → 路由到 `ticket.create`，高风险需确认后执行。
- `转人工` → 路由到 `human.transfer`，高风险需确认后执行。

## 说明

- 三个示例插件来自 `examples/knowledge-query`、`examples/ticket-create`、`examples/human-transfer`，均为本地确定性 fixture，不产生真实副作用。
- LocalWorkflow 的 ActionExecutor 是同步签名，插件 Handler 的异步执行通过 `src/execution/` 下的 worker 线程桥完成。
- 本示例不设测试，编译验证依赖根目录 `npm run build`。
