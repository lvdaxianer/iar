# Tasks

## 1. 决策后端配置与解析

- [x] 1.1 在 `ModelProfile` 中增加 `decisionBackend` 和显式 primary/fallback 关系校验；验证 `function.select`、`plugin.select` 只接受 `jev` 或 `intent-model`，其他 role 拒绝非法字段，并保证同 role/backend 的配置唯一且 fallback 不跨 backend。
- [x] 1.2 新增 `DecisionBackendResolver`，按 `jev` → `intent-model` 顺序解析后端；验证两者同时存在时只选择 JEV、仅有 Intent Model 时选择 Intent Model、两者均无时返回稳定配置错误。

## 2. Intent Model 统一适配器

- [x] 2.1 新增版本化 Intent Model Prompt builder，输入包含 `decisionType`、`decisionVersion`、threshold、有限候选和有序 `candidateIds`；Prompt 明确禁止新增候选、授予权限、执行插件和输出 Markdown。
- [ ] 2.2 新增 `IntentModelDecisionAdapter` 与 `UnifiedDecisionAdapter`，两者都通过 `ModelGateway` 调用，并复用 `validateDecisionOutput`，确保对外只返回现有 `ModelGatewayResult<DecisionResult>`。
- [ ] 2.3 将选定 backend、Prompt 版本、profileId、modelVersion、fallbackUsed 写入脱敏审计 metadata；模型原始 prompt、用户输入和 provider 异常不得进入公开错误或审计正文。

## 3. 路由集成与失败语义

- [ ] 3.1 将 Function/Plugin 决策调用改为使用 `UnifiedDecisionAdapter` 选择 backend，同时保持 Function-first、Plugin ownership、候选重建和最终授权复核不变。
- [ ] 3.2 明确低分、澄清、空候选、非法输出和 provider failure 的处理：低分/澄清不跨 backend，非法输出按现有稳定错误收敛；跨 backend fallback 只有显式配置时才允许。
- [ ] 3.3 保持现有 `DecisionResult`、`RouteResult` 和 API 返回字段兼容，验证 JEV 与 Intent Model 切换不会改变下游路由判断和副作用门禁。

## 4. 测试与回归证据

- [ ] 4.1 在 `tests/integration/model-gateway/model-profile.test.ts` 增加 backend 配置、优先级、重复配置、fallback 关系和 Prompt 版本校验。
- [ ] 4.2 在 `tests/integration/model-gateway/model-gateway.test.ts` 增加 Intent Model 合法输出、candidateIds 改写、未知 choice、错误 decisionType/version、低分和非 JSON 输出测试。
- [ ] 4.3 在 `tests/routing/two-stage-router.test.ts` 与安全测试中验证两种 backend 都只产生同一 `DecisionResult`，且未授权插件、能力扩展和 disabled plugin 仍被拒绝。
- [ ] 4.4 增加 JEV 优先、仅 Intent Model、显式跨 backend fallback 和审计 backend 证据的集成测试；运行 focused tests、`npm run lint`、`npm run build` 与 `npm test`。

## 5. 配置与文档

- [ ] 5.1 更新 `config/models.yaml` 与 `.env.example`，给出 JEV/Intent Model 的 provider、profile、Prompt 版本和优先级示例，不写入真实密钥。
- [ ] 5.2 更新 `docs/README.md` 与根目录 `README.md`，说明两种 backend 的统一 `DecisionResult`、JEV 优先规则、Intent Model Prompt 约束和不授予权限的边界。
- [ ] 5.3 新增 `docs/implementation-audits/parallel-intent-model-decision.md`，记录任务完成情况、审计证据、测试结果和未完成项。

## Workflow follow-up

- 在所有任务通过 per-task audit、全量验证和最终审计后归档本 OpenSpec change。
- 回到 `master`，确认 task 分支已合并，保留已有未跟踪 symlink 不变。
