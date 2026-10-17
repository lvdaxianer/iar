# Parallel Intent Model Decision Implementation Audit

**Status:** PASS（Task 1–4、Task 5.1–5.2 已完成；最终审计与归档待收口）  
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

- Task 1–4 的实现与测试已经通过当前 Task 4 工作树验证。
- 当前阶段未完成项：Task 5.3 的最终审计勾选与 OpenSpec 归档流程。
- 主工作树中的六个预-existing untracked symlink 未修改。
