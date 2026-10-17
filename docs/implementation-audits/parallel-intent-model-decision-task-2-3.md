# Task 2.3 Implementation Audit

## Scope

为 JEV 与 Intent Model 的统一模型调用边界补充审计契约证据：选定 backend、Intent Prompt 版本、profile/model 版本和 `fallbackUsed` 必须可追踪；原始 Prompt、用户输入和 provider 异常不得进入公开错误、audit 或 event。

## Changed files

- `tests/integration/model-gateway/decision-audit.test.ts`

Task 2.2 已提供本任务所验证的生产实现；本任务未修改生产代码、同步 runtime、router 或插件执行链路。

## Evidence

- RED/GREEN：先补充审计字段、脱敏边界和 fallback 顺序断言，再修正统一入口 invalid message 的 exact contract；最终 focused `decision-audit.test.ts` 为 `4/4`，model-gateway suite 为 `67/67`。
- 覆盖 JEV/Intent backend 对称 metadata、Intent Prompt 版本、profileId/profileVersion/modelId/modelVersion、`fallbackUsed`、primary→fallback 顺序和双失败审计保留。
- 覆盖 provider 输入确实包含受限用户候选和 Intent Prompt，但公开 `error`、`audit`、`events` 不包含 Prompt 正文、request、candidateId 或 provider 原始异常。
- 稳定 `provider_failed`、`fallback_failed`、`invalid_request` 和 `no_profile` 错误均有完整 `code/message/retryable/details` 断言；invalid/no-profile 不伪造 audit/event。
- `DecisionResult` 对 JEV/Intent 均逐字段验证，保证切换 backend 不改变下游结果形状。
- 测试文件 331 行、注释比例约 40.4%；`git show --check` 通过。
- `openspec validate parallel-intent-model-decision --strict`：通过。
- 两阶段 review：spec compliance PASS；code quality PASS（P0/P1 为 0）。

## Boundary decisions

- 审计证据只验证公开 `ModelGatewayResult` 边界，不保存或比较完整 Prompt 正文，不触发真实网络或真实模型。
- fallback 证据覆盖成功和双失败路径；两条 attempt 必须保留真实 profile/model/version、backend metadata 和顺序。
- Task 3 的路由集成、跨 backend fallback 语义和同步副作用门禁留待后续任务，不在本任务提前接入。

## Known verification limitation

独立 Task 2.3 worktree 的全量 lint/build 仍可能受到 workspace 多 worktree 类型路径冲突影响；本任务变更仅为 focused 测试，定向类型检查、focused/model-gateway 测试、OpenSpec strict 和 diff 检查均通过。合并后的 `master` 已在前置 Task 2.2 验证 `npm run lint`、`npm run build` 和 `npm test` 全部通过。
