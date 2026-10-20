# IAR

IAR（Intent Action Runtime）是一个面向可恢复行为执行的 TypeScript 运行时。它把用户意图、Function/Plugin 决策、策略确认、Workflow 执行和事件重放组织在同一套可审计的运行时契约中。

> 当前状态：Phase 1～6 已实现，包含实时结构化上下文、可信事实、结构化压缩、异步 SQLite 恢复和端到端验收。

## 核心能力

- 版本化 ABI、Manifest、Function/Plugin 契约与 Schema 校验
- 基于 EventLog 的 BehaviorContext 投影、重放、压缩校验和幂等执行
- 将成功动作的有界公开结果投影为带来源事件、Function、Plugin 元数据的可信事实，并随 SQLite 快照恢复
- 每轮模型调用携带当前问题和实时结构化上下文；兜底模型依据可信事实回答或澄清，不重复触发副作用
- Function → Plugin 两阶段路由，以及可解释的复合规则和类型化决策
- JEV 优先、Intent Model 可替代的统一决策后端；两者都返回同一 `iar.decision/v1`
- Policy Gate、确认范围、权限校验和本地 Workflow 状态机
- Fastify API、Service、Sidecar、CLI、PostgreSQL 与 SQLite 适配器
- 插件隔离执行、签名分发、版本升级、回滚和多租户边界
- 可选 Durable Workflow Runtime、结构化脱敏观测和故障恢复演练

## 快速开始

要求 Node.js `>=24`。

```bash
npm install
npm run build
npm test
```

运行 fake plugin 端到端示例：

```bash
npm run demo:fake-plugin
```

运行 Agent Sandbox：

```bash
npm run demo:sandbox
```

也支持 pnpm，但必须先显式安装依赖；`pnpm run` 不会因为启动脚本而自动访问 registry：

```bash
pnpm install
pnpm run demo:sandbox
```

如果默认端口 `8787` 已被已有 sandbox 进程占用，可先确认并结束该进程，或改用其他本地端口：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
IAR_SANDBOX_PORT=8788 npm run demo:sandbox
```

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run lint` | TypeScript 类型检查，不生成构建产物 |
| `npm run build` | 编译全部 workspace 包 |
| `npm test` | 编译并运行完整测试套件 |
| `npm run demo:fake-plugin` | 运行 fake plugin 生命周期与 replay 示例 |
| `npm run demo:sandbox` | 启动 Agent Sandbox 交互演示 |

## 项目结构

```text
packages/
├── contracts/            # 公共契约、Manifest 与 Schema
├── plugins/              # Plugin SDK、Host、注册与生命周期
├── decision/             # 类型化决策与 Decision Provider
├── rule-engine/          # 复合规则与候选集约束
├── runtime/              # 行为运行时、重放与路由
├── storage/              # EventStore、持久化 SPI/Runtime 与 SQLite Provider
├── control-plane/        # Tenant control-plane 与插件分发
├── observability/        # 观测记录、脱敏与 system plugin
├── subscriptions/        # Hook、StateEvent 与订阅分发
├── workflow/             # Policy Gate 与本地 Workflow
├── cli/                  # install、enable、disable、inspect、replay
└── adapters/             # Fastify、Service、Sidecar、PostgreSQL、Temporal 等适配器
examples/
├── agent-sandbox/        # 根级组合根与可交互演示
└── plugins/              # fake-plugin、knowledge-query、ticket-create、human-transfer
tests/                    # 契约、重放、路由、安全、服务化与故障演练测试
docs/                     # 完整架构说明与实现审计
```

`examples/` 不参与 workspace package 发布；只有可复用的核心运行时能力进入 `packages/`。插件示例集中放在 `examples/plugins/`，`agent-sandbox` 保持根级位置作为组合根。`plugins/sdk` 与 `plugins/host` 当前仍属于同一内部生命周期边界；只有出现独立发布、独立版本兼容承诺或外部插件作者需要单独安装时，才拆回独立 SDK 包。

## 设计边界

- Function 决定“做什么”，Plugin 只负责已确定 Function 的具体实现。
- Policy、确认、权限和能力校验必须发生在副作用执行之前。
- EventLog 是可恢复行为状态的事实来源；上下文压缩不能覆盖关键状态。
- 短动作默认使用本地确定性运行时；只有明确的定时器、跨服务或补偿需求才进入 Durable Runtime。
- 插件卸载撤销当前注册但保留历史事件，升级失败时恢复精确的上一版本。

## 决策模型兼容切换

Function 和 Plugin 决策都经过 `ModelGateway` 与 `UnifiedDecisionAdapter`。JEV 与 Intent Model 是平行 backend，但下游只看到同一个 `DecisionResult`，不会因为切换模型而改变路由字段：

```json
{
  "schemaVersion": "iar.decision/v1",
  "decisionType": "function.select",
  "decisionVersion": "runtime.v1",
  "status": "choice",
  "choice": "candidate-id",
  "score": 0.95,
  "reasonCode": "intent_match",
  "candidateIds": ["candidate-id"]
}
```

- 同一决策阶段同时配置两个 backend 时固定选择 JEV；没有 JEV primary 时才选择 Intent Model。
- Intent Model 使用固定 Prompt `iar.intent-decision-prompt/v1`，要求只返回 JSON、原样保留有序 `candidateIds`，不得新增候选、授予能力、授权动作或执行插件。
- 低分或歧义结果仍是 `needs_clarification`，不会自动切换成另一条可执行选择。
- backend 只提供候选选择建议；Function-first、Plugin ownership、租户/用户/环境授权、Manifest capability 和最终 Policy/Confirmation 复核仍由 Runtime 完成。
- 跨 backend fallback 默认关闭；只有调用方显式设置 `crossBackendFallback: true`，并且发生 provider/timeout 类失败时才允许降级。

配置示例见 [`config/models.yaml`](config/models.yaml)，模型接入环境变量见 [`.env.example`](.env.example)。

### 模型连接变量覆盖

每个 `ModelProfile` 可用 `environment` 声明非敏感环境变量名：

```json
{
  "environment": {
    "endpoint": "IAR_LLM_BASE_URL",
    "apiKey": "IAR_LLM_API_KEY",
    "modelId": "IAR_LLM_MODEL_ID"
  }
}
```

普通交互模型默认使用 `IAR_LLM_BASE_URL`、`IAR_LLM_API_KEY`、`IAR_LLM_MODEL_ID`；Intent Model 默认使用独立的 `IAR_INTENT_MODEL_ENDPOINT`、`IAR_INTENT_MODEL_API_KEY`、`IAR_INTENT_MODEL_ID`。profile 映射中的非空变量值优先于 provider 默认值；模型名最终回退到 profile 的 `modelId`，endpoint/API key 缺失时 fail-closed。变量实际值不会进入 profile、审计或错误消息。

agent-sandbox 默认同时加载 JEV 和 Intent Model，并固定 JEV 优先。设置 `IAR_SANDBOX_DECISION_BACKEND=intent-model` 可运行 Intent-only 路径；两条路径都通过同一个 `iar.decision/v1` 返回契约。

### 沙箱会话

`POST /api/sessions` 创建独立会话并返回 `sessionId`；随后使用 `/api/sessions/{sessionId}/chat`、`confirm`、`compact`、`state` 和 `reset`，用 `DELETE /api/sessions/{sessionId}` 释放。服务重启后可先调用 `POST /api/sessions/{sessionId}/resume` 恢复最近成功写入的结构化快照，再继续提问。原 `/api/*` 入口仍共用一个兼容会话。默认最多 32 个独立会话、空闲 30 分钟过期，每会话最多 16 个在途或排队请求；达到状态操作预算后需重置。默认使用内置 SQLite Provider，文件路径为 `IAR_SANDBOX_SQLITE_PATH` 或 `./data/iar-sandbox.sqlite`；正常关闭会等待已接受快照写入，进程突然退出前尚未提交的更新可能丢失。

会话持久化通过 `SessionPersistenceProvider` SPI 接入：设置 `IAR_PERSISTENCE_PROVIDER` 和 `IAR_PERSISTENCE_MODULE` 可替换外部 Provider，`IAR_PERSISTENCE_OPTIONS_JSON` 传递 JSON 配置。Provider 接收到的每条消息、事件和快照都携带同一个 `sessionId`；恢复只加载该 ID 的最新有效结构化快照，不把会话原文当作模型指令。详见[会话接口与安全边界](docs/README.md#1221-沙箱会话接口与安全边界)和[Provider 接入规范](docs/README.md#1222-会话持久化-provider-接入规范)。

会话 ID 仅隔离沙箱状态，不是身份认证或租户授权；持有 ID 的客户端可以读取状态并确认操作。沙箱只适合受信任的本机使用，生产接入必须另外实施认证、逐会话授权和传输保护。调用约束及错误码详见[会话接口与安全边界](docs/README.md#1221-沙箱会话接口与安全边界)。

### 与 Pi 集成

IAR 提供 `@iar/pi-bridge` Pi Package，把 Pi 的输入扩展为一层可选的意图路由。Pi 核心不需要修改：扩展在 Pi 的 `input` hook 中先调用 IAR，IAR 只返回处置结果；`pass_through` 继续交给 Pi Agent，其余结果由扩展展示并结束当前 Pi turn。

启动本地 IAR Bridge：

```bash
npm run demo:sandbox
```

如果包已发布到 npm，可直接安装到 Pi：

```bash
pi install npm:@iar/pi-bridge
```

本地开发包可使用 Pi 的本地路径安装：

```bash
pi install -l /Users/lvdaxianer/workspace/my/project/iar/packages/adapters/pi
```

扩展默认连接 `http://127.0.0.1:8787`，也可通过 `IAR_PI_BRIDGE_URL` 覆盖。确认或取消待执行动作使用 `/iar-confirm` 和 `/iar-cancel`。IAR 不可用时扩展默认 fail-closed，当前输入会被安全阻断；如明确接受降级风险，可在 SDK 中设置 `onUnavailable: "continue"`。

SDK 中也可以直接把工厂加入 Pi 的 `DefaultResourceLoader`：

```ts
import { createAgentSession, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createIarExtension } from "@iar/pi-bridge";

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [
    createIarExtension({ baseUrl: process.env.IAR_PI_BRIDGE_URL ?? "http://127.0.0.1:8787" }),
  ],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ resourceLoader });
```

两套会话职责保持分离：Pi 会话负责对话历史、模型调用和 Pi 扩展生命周期；IAR 会话负责意图识别、路由、策略、确认、执行和可恢复业务状态。Bridge 只保存 `piSessionId → iarSessionId` 映射以及当前 `actionId`，不会复制 IAR 的行为状态或 Action 输入。当前 Sandbox 的映射保存在进程内，服务重启后应在打开 Bridge 会话时显式传入可恢复的 `iarSessionId`；生产部署还需要在 Bridge 前增加认证、租户授权和传输保护。

Bridge 协议版本为 `iar.pi-bridge/v1`，输入处置包括：

- `pass_through`：IAR 未匹配到可执行业务意图，继续由 Pi Agent 回答。
- `handled`：IAR 已完成查询或动作，结果直接展示给用户。
- `clarification`：IAR 需要用户补充信息，结果直接展示，不触发 Pi Agent。
- `awaiting_confirmation`：IAR 已准备待确认动作，使用 `/iar-confirm` 或 `/iar-cancel` 继续。

### 通用追问与动作边界

每轮请求都会把当前问题和实时 `BehaviorContext` 一起交给语义模型。模型先输出固定 `action`：`query`、`create`、`update`、`delete`、`transfer`、`execute` 或 `unknown`；运行时只按会话范围、插件状态、权限和 Plugin Manifest 的 `actionTypes` 过滤有限候选，不根据工单、人工服务或其他业务关键词写路由分支。

如果没有合适的 Plugin/Function，运行时不准备也不执行 Action，而是把当前问题、结构化上下文、`verified` facts、`pending` 和未命中原因交给 Response Model。Response Model 自己判断是基于事实直接回答，还是说明缺少信息并反问；它不能创建、确认或执行功能。明确的新动作仍然经过原有权限、策略、确认、幂等和事实投影链路。

### 沙箱安全日志

沙箱记录 HTTP 请求审计和模型调用的安全元数据，默认不输出正常模型调用的 DEBUG 日志。拥有进程信号权限的本机运维人员可以向沙箱进程发送 `SIGHUP` 切换模型 DEBUG，重复发送恢复关闭；部署环境须限制进程信号权限并确认没有其他 SIGHUP 处理约定。日志不记录模型输入、输出、请求头、凭据、URL 查询或原始异常。详见[安全与观测方案](docs/README.md#123-观测字段)。

安全日志默认异步写入标准错误，宿主可注入专用输出；须独占输出或统一串行写入，共享输出无法保证跨写入者行原子性。队列有界且满时丢弃，可通过进程内只读状态查询丢弃和卡住情况；输出故障及进程退出可能造成日志丢失，轮转和持久化由宿主负责。

启动成功会输出受控 `sandbox.start` 记录，包含本地监听地址的主机和端口、实际模式以及是否自动回退；不向标准输出写启动消息。

## 文档与验证

- [完整架构与能力边界](docs/README.md)
- [定义 Function](docs/defining-functions.md)：Function 契约、与 Plugin 的关系、新增 Function 的四步与检查清单
- [定义 Plugin](docs/defining-plugins.md)：Manifest 逐字段详解、Handler 契约、可信事实声明、从注册到执行的完整链路
- [Agent Sandbox 上下文追问测试用例](docs/agent-sandbox-test-cases.md)
- [Phase 1～5 最终实现审计](docs/implementation-audits/phase-1-5-final.md)
- [已归档的 OpenSpec 计划](openspec/changes/archive/2026-10-17-iar-five-phase-roadmap/tasks.md)

最终验证结果以当前提交的 `npm run lint`、`npm run build`、`npm test` 和 OpenSpec 严格校验为准；端到端回归覆盖多会话隔离、自然追问、新操作确认、压缩及重启恢复。
