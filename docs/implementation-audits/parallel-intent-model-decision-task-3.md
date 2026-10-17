# Task 3 Implementation Audit

## Scope

为 JEV 优先的统一决策入口补充显式跨 backend fallback 语义，并验证 Function/Plugin 路由继续只消费统一 `DecisionResult`。同 backend profile fallback 保持原有关系图语义；跨 backend 只由调用方显式开启，且只允许 provider/timeout/no_provider 类失败触发。

## Changed files

- `packages/decision/src/model-gateway/types.ts`
- `packages/decision/src/model-gateway/decision-backend.ts`
- `packages/decision/src/model-gateway/gateway.ts`
- `packages/decision/src/model-gateway/adapters.ts`
- `packages/decision/src/index.ts`
- `packages/runtime/src/routing.ts`
- `tests/integration/model-gateway/model-gateway.test.ts`
- `tests/routing/two-stage-router.test.ts`
- `tests/security/phase-4-security.test.ts`

## Evidence

- RED/GREEN：先补充 JEV provider failure、显式 `crossBackendFallback`、低分澄清和 schema invalid 的行为测试，再实现 gateway/adapter 边界；focused suite 最终 `39/39` 通过。
- 同时配置 JEV/Intent 时 resolver 只选择 JEV；JEV failure 默认不调用 Intent；显式开启后按 JEV attempt → Intent attempt 顺序调用，并保留两条 audit/event 证据。
- 跨 backend fallback 使用目标 adapter 的输入：JEV → Intent 时 provider 实际收到 `iar.intent-decision-prompt/v1`，公开 audit 只保留 Prompt 版本、backend、provider 和候选数量摘要。
- low score/`needs_clarification`、schema invalid 不跨 backend；malformed request 仍在 provider 前 fail-closed。
- 同 backend fallback 优先于跨 backend fallback；同 backend fallback 失败且仍属于 provider/transport failure 时才继续尝试显式跨 backend。
- 跨 backend 输入进入 fallback profile 前重新 `structuredClone + deepFreeze`；provider mutation 不能改写 Prompt 版本、audit metadata 或后续 attempt 输入。
- 路由测试验证 Intent-shaped `DecisionResult` 不改变 Function-first、Plugin ownership、disabled/unauthorized/capability final gate；新增向后兼容的 `TwoStageRouter.routeAsync()` 真实消费 `UnifiedDecisionAdapter`，同步 `route()` API 未修改。
- `npm run lint`：通过；`npm run build`：通过；`git diff --check`：通过；`npm test`：全量 `296/296` 通过。
- OpenSpec strict validation：通过。

## Boundary decisions

- `ModelProfile.fallbackProfileId` 仍只允许同 role/backend；跨 backend 是 `ModelGatewayInvocationOptions.crossBackendFallback` 的显式运行时策略，不改变配置图语义。
- `UnifiedDecisionAdapter` 默认关闭跨 backend fallback；开启时仍只返回原有 `Promise<ModelGatewayResult<DecisionResult>>`，不向下游暴露 backend-specific result。
- `DecisionResult`、`RouteResult`、同步 `DecisionProvider`、同步 `RouteRequest` 和 `TwoStageRouter.route()` 保持兼容；新增 `routeAsync()` 只把 Unified adapter 的受限结果交给既有最终门禁，不授予模型权限、能力或插件执行权。
- provider 原始异常、Prompt 正文和用户输入不进入公开错误或审计正文；跨 backend 的第二次调用仅使用 adapter 构造的受限输入。

## Known verification limitation

本任务的 focused suite、lint、build、diff 检查、完整 `npm test` 和 OpenSpec strict 均已通过。
