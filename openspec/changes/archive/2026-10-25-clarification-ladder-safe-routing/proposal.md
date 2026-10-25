# Proposal

## Why

真实模型能够命中一个业务 Function，但在用户只说“网关这边帮我看看”或“创建一张工单”时，通常还没有唯一的 Operation 或完整参数。当前运行时仍可能接受模型推断的默认 Operation、进入错误的 Handler 或过早进入确认，无法可靠地通过反问补全后在同一会话继续执行。

本变更把“命中但不完整”变成可验证的澄清阶梯，并用端口 8878 的真实模型在一个固定会话中验证 50 个场景，发现缺口后继续修复和回归，直到运行时测试与真实模型语义验收同时通过。

## What Changes

- Function 已命中但 Operation 未由当前输入明确确定时，返回该 Function 的有限 Operation 目录，不使用 Handler 默认值或模型猜测值。
- Operation 已确定但业务参数缺失、非法或冲突时，只追问当前 Function Schema 的缺失字段，并继承同一会话中已验证的字段。
- 补充 Operation 或参数后，仍重新通过 Schema、授权、策略、确认和幂等门禁；高风险动作在信息完整后才进入确认。
- 发现模型跨 Plugin、跨 Function 或跨 Operation 推断时，保留已命中身份并 fail-closed，不静默改路由。
- 增加真实模型 50 场景语义验收器：固定 `piSessionId`、固定 8878 服务、覆盖 L1/L2/L3 以及多轮补全，检查处置、身份、原因码、澄清内容和确认边界。
- 将真实模型测试中的失败样例转为确定性回归测试，避免只验证 HTTP 成功而漏掉语义错误。

## Capabilities

### New Capabilities

无。本变更补强已有澄清、嵌套路由和连续补参能力。

### Modified Capabilities

- `nested-plugin-function-routing`: Operation 必须来自当前输入或已验证的同会话上下文；缺失时展示有限目录并阻止执行。
- `function-call-routing`: Function-call 的 Operation 与参数边界需要在动作构造前形成可解释的澄清结果，不能接受模型默认值。
- `continuation-recovery`: 多轮补充必须绑定原 Function/Plugin，按字段继承并在补齐后重新走完整安全门禁。

## Impact

- 影响 `examples/agent-sandbox` 的 Operation 选择、参数收集、澄清回复和会话恢复。
- 影响 `scripts/run-real-pi-50-scenarios.mjs` 及新增语义断言，测试必须通过 `http://127.0.0.1:8878` 的真实模型并保持单一 `piSessionId`。
- 不新增外部依赖，不改变已完整请求的公开 Function/Plugin 标识；不记录原始 prompt、模型全文或凭据。
