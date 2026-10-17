# Parallel Intent Model Decision Implementation Audit

**Status:** PASS（Task 1–5 全部完成，OpenSpec 归档待执行）
**Date:** 2026-10-17
**Change:** `parallel-intent-model-decision`
**Integration branch:** `master`

## Task 4 per-task gate

Task 4 的配置、测试与文档边界已通过审计：

- `config/models.yaml` 同时保留 JEV 与 Intent Model 的 selection profiles；JEV profile 明确声明 `decisionBackend: "jev"`，Intent profile 使用 `decisionBackend: "intent-model"` 与 `iar.decision/v1`。
- `.env.example` 只增加环境变量占位符，没有真实密钥，并说明固定 Prompt 版本与显式跨 backend fallback 开关。
- 根目录 `README.md` 与 `docs/README.md` 说明统一 `DecisionResult`、JEV 优先、Intent Model Prompt 约束、低分澄清和最终授权边界。
- profile 相关测试 fixture 已区分 JEV-only、Intent-only、legacy 和双 backend 场景，避免示例配置扩展后误报 primary 冲突。

## Acceptance matrix

| Area | Evidence | Result |
| --- | --- | --- |
| Profile backend and fallback validation | `tests/integration/model-gateway/model-profile.test.ts` | PASS |
| JEV priority and Intent-only resolution | `tests/integration/model-gateway/decision-backend.test.ts` | PASS |
| Intent Model prompt/output contract | `tests/integration/model-gateway/intent-model-decision.test.ts` | PASS |
| Provider failure, explicit cross fallback and redaction | `tests/integration/model-gateway/model-gateway.test.ts` | PASS |
| Sync/async two-stage routing compatibility | `tests/routing/two-stage-router.test.ts` | PASS |
| Capability, ownership and disabled-plugin gates | `tests/security/phase-4-security.test.ts`, `tests/routing/two-stage-router.test.ts` | PASS |
| Documentation and configuration boundary | `README.md`, `docs/README.md`, `config/models.yaml`, `.env.example` | PASS |

## Verification evidence

```text
focused model-gateway tests                                      44/44 PASS
focused resolver and routing tests                               13/13 PASS
npm run lint                                                     PASS
npm run build                                                    PASS
npm test                                                         296/296 PASS
git diff --check                                                  PASS
openspec validate parallel-intent-model-decision --strict        PASS
```

## Compatibility and security review

- 对外仍使用 `DecisionResult`、`ModelGatewayResult<DecisionResult>`、`RouteResult` 和既有 API 字段；backend 切换不向下游暴露新的分支协议。
- JEV 与 Intent Model 都只能提出有限候选选择；Function-first、Plugin ownership、候选重建、授权、Manifest capability、Policy 和 Confirmation 复核保持在 Runtime。
- 未配置 JEV 时 Intent Model 才成为 primary；两者同时存在时 resolver 只选择 JEV。
- 跨 backend fallback 默认关闭，仅对显式 `crossBackendFallback: true` 且 provider/timeout/no-provider 类失败开启；低分、澄清、schema-invalid 不跨 backend。
- provider 异常、Prompt、用户输入和密钥不会进入公开错误或审计正文；审计只保留 backend、profile/model 版本和稳定失败分类。

## Repository state

- Task 1–5 的实现、测试、配置、文档和最终审计已经合并到 `master`。
- `openspec/specs/bounded-routing/spec.md` 已同步本变更的 JEV/Intent Model 统一决策契约与 Prompt 边界。
- 未完成项：无；仅保留 OpenSpec 归档这一工作流收口动作。
- 主工作树中的六个预-existing untracked symlink 未修改。

## Final task completion

| Task | Scope | Result |
| --- | --- | --- |
| 1 | `decisionBackend` 配置校验与 JEV → Intent Model resolver | 完成 |
| 2 | 版本化 Intent Prompt、Intent adapter 与统一返回契约 | 完成 |
| 3 | Function/Plugin 异步路由接入、失败语义与授权边界 | 完成 |
| 4 | profile、adapter、路由、安全和 fallback 回归测试 | 完成 |
| 5 | 配置示例、`.env.example`、根 README、架构文档与审计 | 完成 |

## Final review summary

- Task 3 runtime review 已通过：P0/P1 为 0；审查后的 cross-backend input snapshot 已冻结，且真实 `routeAsync()` 会经过 `UnifiedDecisionAdapter`。
- Task 4 配置/文档/test fixture review 已通过：无真实密钥、无 API/DecisionResult 破坏性变更、无超出 scope 的文件修改。
- 兼容性结论：JEV 与 Intent Model 对下游都返回相同 `iar.decision/v1` / `DecisionResult`；JEV 存在时优先，JEV 缺失时 Intent Model 才成为 primary。
