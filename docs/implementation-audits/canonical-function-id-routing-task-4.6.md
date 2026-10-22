# Canonical Function ID Routing — Task 4.6 Audit

**Status:** PASS  
**Date:** 2026-10-22  
**Integration branch:** `master`

## Scope

修正兼容决策路径的 JEV provider 绑定。JEV 配置完整时，`function.select` / `plugin.select` profile 使用真实 `jev` provider；JEV 配置缺失时，沙箱只保留 Intent Model profile；scripted 模式仍可使用离线确定性 provider。

## Evidence

- `examples/agent-sandbox/src/models/llm-provider.ts` 新增 `JevModelProvider`，调用 JEV System One `state + choice question` 协议，并将 typed answer 映射为公共 `iar.decision/v1`。
- `examples/agent-sandbox/config/models.brain.json` 的四个 JEV profile 均使用 `provider: "jev"`，不再使用 `mock`。
- `examples/agent-sandbox/src/session-dependencies.ts` 在 brain 模式注册真实 `jev` provider，在 scripted 模式保留离线 provider。
- JEV 响应仍经过 `ModelGateway` 的超时、重试、公共 Decision Schema、候选集合、阈值和 Runtime 权限门禁。
- JEV endpoint、API key 和模型 ID 只从 profile environment 映射读取；日志不记录请求正文或密钥，响应体复用统一 256 KiB 有界读取与取消清理，并以 `model.jev.systemone` 区分协议目标。

## Verification

```text
focused environment provider tests       6/6 PASS
focused sandbox backend tests             5/5 PASS
full npm test                              PASS (exit code 0)
lint, build, diff --check                  PASS
openspec strict validation                 PASS
```

## Review result

- P0/P1：0
- 未配置 JEV 时不再静默调用 JEV/mock profile。
- JEV 的模型结果只作为候选建议，不能创建候选、授予权限或直接执行 Function。
- JEV 网络失败、HTTP 失败、格式失败和响应超限均保留稳定错误分类，并在读取失败时释放响应流。
