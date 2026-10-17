# Task 2.2 Implementation Audit

## Scope

新增 Intent Model 决策适配器和 JEV/Intent Model 统一决策入口。两种 backend 都通过 `ModelGateway` 调用，并复用同一个 `DecisionResult`、`ModelGatewayResult` 和 `validateDecisionOutput` 契约；当两者同时配置时由 resolver 选择 JEV，仅配置 Intent Model 时走 Intent Model。

## Changed files

- `packages/decision/src/model-gateway/adapters.ts`
- `packages/decision/src/model-gateway/decision-backend.ts`
- `packages/decision/src/model-gateway/gateway.ts`
- `packages/decision/src/model-gateway/intent-prompt.ts`
- `packages/decision/src/model-gateway/types.ts`
- `tests/integration/model-gateway/intent-model-decision.test.ts`

## Evidence

- RED/GREEN：先验证 malformed 请求会触发 provider，再加入共享 `canonicalizeDecisionRequest`；最终 focused model-gateway suite `63/63` 通过。
- 覆盖 Intent Prompt 输入、统一 DecisionResult、JEV 优先、Intent-only、`plugin.select`、same-backend fallback、稳定 `model.no_profile`、resolver `profileId` 绑定、低分澄清、非法输出、Proxy/getter 和 provider 异常脱敏。
- JEV 与 Intent Model 共用严格 request canonicalizer；threshold 越界、空候选和额外字段在 provider 前拒绝，调用次数为 0。
- 决策 audit 只保留 provider、backend、candidateCount、Prompt 版本和稳定 reason，不写入 request、systemPrompt、candidateId 或 provider 原始异常。
- `gateway.ts` 346 行，`intent-prompt.ts` 313 行，测试文件 350 行；`git diff --check` 通过。
- `openspec validate parallel-intent-model-decision --strict`：通过。
- 两阶段 review：spec compliance PASS；code quality PASS（P0/P1 为 0）。

## Boundary decisions

- `UnifiedDecisionAdapter` 只解析并委托一个 backend；resolver 返回的 `profileId` 会继续传给 gateway，防止 resolver 与 gateway registry 不一致时选错 primary。
- fallback 只能沿选定 role/backend 的显式关系执行，不能因 primary 失败隐式切换到另一 backend。
- Intent Model 只接收版本化 JSON Prompt，不获得授权、能力扩展或插件执行权限；同步 DecisionProvider、TwoStageRouter 和副作用门禁保持不变。
- malformed 输入、Proxy/getter 异常和 provider 异常均转换为稳定错误，不泄露原始输入、Prompt 或异常正文。

## Known verification limitation

`npm run lint`、`npm run build` 和依赖它们的全量 `npm test` 在独立 worktree 中仍受既有跨 worktree workspace 类型路径冲突阻断（涉及未修改的 workflow、plugin-host、subscriptions 等类型）；变更文件定向检查、完整 model-gateway focused suite、OpenSpec strict 和 diff 检查均通过。
