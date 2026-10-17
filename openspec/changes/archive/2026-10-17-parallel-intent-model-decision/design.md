# Design

## Context

当前 `packages/decision` 已有 `ModelGateway`、`JevDecisionAdapter`、`SemanticExtractorAdapter` 和 `validateDecisionOutput`。JEV 目前承担 `function.select` 与 `plugin.select`，而 `ModelProfileRegistry` 只按 role 解析 primary/fallback profile。`DecisionResult` 已经是版本化、有限候选、可阈值校验的公共输出，因此本变更不新增下游结果协议。

## Goals / Non-Goals

**Goals:**

- 让 JEV 和普通意图模型都实现同一个 Decision Adapter 边界。
- 让意图模型直接返回 `iar.decision/v1`，由现有公共校验器负责规范化。
- 在配置层显式标识决策后端，并固定 JEV 优先、Intent Model 兜底选择顺序。
- 固定 Prompt 版本、输出字段、候选集约束和非授权边界。
- 保留当前路由、权限、能力、租户、环境和 Policy Gate 的最终复核。

**Non-Goals:**

- 不改变 `DecisionResult` 字段或 `iar.decision/v1` 版本。
- 不让普通模型直接生成 Function/Plugin 之外的新候选。
- 不让模型决策直接授予能力、确认权限或执行插件。
- 不在本变更中替换 `semantic.extract` 的 `SemanticFrame` 协议。
- 不默认同时调用 JEV 和 Intent Model；并行表示后端可共存，不表示每次请求都双调用。

## Decisions

### 1. 使用显式 decision backend 标识

在 `ModelProfile` 增加仅对 `function.select` / `plugin.select` 有效的 `decisionBackend`：`jev` 或 `intent-model`。`provider` 仍表示实际 provider 注册名，不能承担业务后端语义。Registry 校验同一 role/backend 的 primary profile 唯一，fallback 必须保持相同 role/backend。

选择顺序固定为：

```text
function.select / plugin.select
  -> decisionBackend=jev（存在则优先）
  -> decisionBackend=intent-model（JEV 不存在时使用）
  -> model.no_provider / model.no_profile
```

JEV 调用失败是否跨后端切换由显式 `crossBackendFallback` 配置决定；默认不因低分、澄清或业务拒绝切换，避免两个模型对同一输入产生不可审计的隐式竞争。

### 2. Intent Model 复用 `DecisionResult`

`IntentModelDecisionAdapter` 的输出验证路径与 `JevDecisionAdapter` 相同：先通过公共 Decision Schema，再调用 `validateDecisionOutput(request, raw)`。它不得把 `SemanticFrame` 直接塞入 Function/Plugin 路由，也不得自行把 intent 文本映射为权限。

固定 Prompt 要求模型返回：

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

Prompt 版本写入模型调用 input 和审计 metadata；模型必须原样复制决策阶段、版本和有序候选 ID，不得创建候选、授予能力或执行动作。

### 3. 用 Unified Decision Adapter 暴露稳定切换入口

新增 `DecisionBackendResolver` 和 `UnifiedDecisionAdapter`。上层只依赖统一的 `decide()` 结果，不读取 JEV/Intent Model 的内部 provider。Resolver 根据 role、配置和 JEV 优先级选出一个 backend；被选 adapter 仍通过 `ModelGateway` 获得 timeout、retry、fallback、redaction、Schema validation 和 audit。

现有 `JevDecisionAdapter` 保留，作为 JEV 专用实现和兼容入口；新增的统一入口负责后端选择，避免把选择逻辑散落在路由器和 API 层。

### 4. 最终权限复核不下沉给模型

模型返回的 `choice` 只能作为候选选择建议。`TwoStageRouter`、PluginHost 和 Policy Gate 继续负责 Function-first、Plugin ownership、enabled/authorized、capability、tenant、actor、environment 和 confirmation 复核。Intent Model 与 JEV 只在“选择输出”层可替换。

## Risks / Trade-offs

- [模型返回合法 JSON 但语义错误] → 继续使用有限候选、规则证据、阈值和最终权限复核；低分统一转 `needs_clarification`。
- [配置同时存在多个同 role/backend profile] → Registry 初始化阶段 fail-closed，要求显式 primary/fallback 关系。
- [JEV 故障时隐式切换模型导致结果漂移] → 默认只允许同 backend fallback；跨 backend fallback 必须显式配置并写入审计。
- [Prompt 与 `DecisionResult` 演进不一致] → Prompt 使用独立版本 `iar.intent-decision-prompt/v1`，测试锁定字段、候选顺序和拒绝场景。
- [普通模型 provider 协议各不相同] → provider 只负责把模型响应交给 adapter；adapter 与 ModelGateway 负责固定输入、输出校验和稳定错误。
