# Tasks

## 1. Agent 配置与提示词组合边界

- [x] 1.1 扩展 `packages/runtime/src/bootstrap/types.ts` 与 `packages/runtime/src/bootstrap/runtime.ts`，新增有界的 Agent `systemPrompt` 配置、冻结配置快照和稳定校验；测试覆盖默认值、有效值、超长值、非字符串值和配置不可变性，运行 `npm test -- --test-name-pattern="systemPrompt|自我介绍配置"`。

  - 任务边界：只负责 Runtime 公共配置契约和归一化，不修改模型请求和页面。
  - 允许文件：`packages/runtime/src/bootstrap/**`、`tests/contract/**`。
  - 不在范围：Prompt 文案、Pi Agent、bridge 字段。
  - 依赖：无。
  - 执行策略：主 Agent 直接执行；配置契约与后续 Prompt Builder 共享边界，拆分委派会增加冲突，记录此直接执行理由后再写 RED 测试。

- [x] 1.2 新增受控 Prompt Builder，将固定 Runtime 规则、Agent 总体提示词、Plugin 附加提示词和角色协议按固定顺序组合；测试确保用户提示词不能覆盖 Schema/安全约束，且不把 Function 输出当作系统指令，运行该模块的 focused test 与 `npm run lint`。

  - 任务边界：只负责纯提示词组合与输入边界，不发起网络请求。
  - 允许文件：`examples/agent-sandbox/src/models/**`、对应 `tests/unit/**` 或 `tests/integration/agent-sandbox/**`。
  - 不在范围：Response Model 调用、Pi Agent 实例创建。
  - 依赖：1.1 的 `systemPrompt` 配置字段。
  - 重点验证：空 Prompt 向后兼容、长度受控、固定协议始终存在。

## 2. Response Model 与 Pi Agent 汇总链路

- [x] 2.1 将 Agent 总体提示词贯通沙箱会话到 `response.generate`，修改普通和流式 Response Prompt，允许 Markdown 出现在 `iar.response/v1.text`，并确保 self-introduction 的 `mode=model` 走 Response Model；测试捕获模型输入，验证能力清单、`extraPrompt`、总体提示词均到达模型，且 `direct/none` 不调用模型。

  - 任务边界：负责 `session-replies.ts`、`model-input-transport.ts`、`llm-provider.ts` 及相关模型调用测试。
  - 允许文件：`examples/agent-sandbox/src/session-replies.ts`、`examples/agent-sandbox/src/models/model-input-transport.ts`、`examples/agent-sandbox/src/models/llm-provider.ts`、相关测试。
  - 不在范围：Pi Host 页面、bridge replySource。
  - 依赖：1.1、1.2。
  - focused verification：self-introduction integration test、function response contract tests、stream/non-stream response tests。

- [x] 2.2 将同一 Agent 总体提示词传入 Pi Agent 固定系统提示词，保持 Pi 的业务边界和能力目录上下文；测试验证 pass-through 使用总体提示词，handled 的 self-introduction 不调用 Pi，运行 Pi delegate 与 bridge integration tests。

  - 任务边界：负责 Pi delegate options、Agent 构造和会话装配。
  - 允许文件：`examples/agent-sandbox/src/models/pi-agent-delegate.ts`、`examples/agent-sandbox/src/session-core.ts`、`examples/agent-sandbox/src/session-dependencies.ts`、相关测试。
  - 不在范围：IAR 路由算法和 Plugin Handler。
  - 依赖：1.1、1.2、2.1 的配置传递形状。
  - focused verification：Pi system prompt capture、pass-through/handled route tests。

## 3. 回复来源可观测性与页面展示

- [x] 3.1 为 TurnResult、Pi bridge payload 和 HTTP/SSE 映射增加受控 `replySource` 枚举，分别标记 `direct_function`、`response_model`、`pi_agent`、`none`；测试验证 self-introduction 返回 `response_model`，direct/none/pass-through 分别返回正确来源且不泄露 Prompt 原文。

  - 任务边界：只修改内部结果类型、bridge 映射和 API 契约测试。
  - 允许文件：`examples/agent-sandbox/src/session-types.ts`、`examples/agent-sandbox/src/session.ts`、`examples/agent-sandbox/src/http-pi-bridge-routes.ts`、`examples/agent-sandbox/src/pi-host/**`、相关测试。
  - 不在范围：提示词内容和模型行为。
  - 依赖：2.1、2.2。

- [ ] 3.2 更新 Pi Host/Agent Sandbox 调试面板，显示实际 Plugin、Function、回复来源和 model/direct/none 模式；保留旧字段兼容并验证页面模板、SSE 事件和自我介绍端到端流程，运行 `npm test`、`npm run lint`、`npm run build`。

  - 任务边界：只负责调试信息渲染和回归测试，不新增独立配置页。
  - 允许文件：`examples/agent-sandbox/web/**`、`examples/agent-sandbox/src/pi-host/web/**`、页面集成测试。
  - 不在范围：Agent 配置持久化实现以外的页面功能。
  - 依赖：3.1。

## 4. 集成验证

- [ ] 4.1 执行全量契约、集成、构建、包校验和 OpenSpec 严格校验，逐项核对三层提示词、self-introduction model 汇总、direct/none 边界、Pi 兜底和回复来源元数据；验证命令包括 `npm test`、`npm run lint`、`npm run build`、`npm run verify:packages`、`openspec validate agent-prompt-layers --strict`。

## Workflow follow-up

- 每个实现任务完成 focused test、broader verification、plan consistency audit、code-review-spec 和 per-task audit 后，立即标记对应 checkbox 并提交。
- 所有任务完成后执行最终审计，并按项目 OpenSpec 流程归档 `agent-prompt-layers`。
