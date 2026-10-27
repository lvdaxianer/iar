# Spec Delta

## ADDED Requirements

### Requirement: Incremental continuation restores the verified target

在已验证 Function/Plugin 路由存在且当前输入明确表达对该目标的增量修改、继续调整或重试时，Runtime SHALL 先恢复该目标并收集当前轮参数，再应用语义不完整门禁或 Pi pass-through。恢复后的输入 SHALL 重新经过 Schema、授权、策略和确认流程。

#### Scenario: Incremental numeric continuation restores the target

- **WHEN** 当前会话已经成功执行 API 网关限流调整，且用户说“再往上调 50”或等价的增量表达
- **THEN** Runtime 复用已验证的 API 网关目标，将当前值与增量语义合成为新的明确参数，形成新的待确认动作，不得转为 Pi pass-through 或把 50 当作绝对值

#### Scenario: Incremental continuation remains fail-closed

- **WHEN** 增量表达无法确定目标或单位
- **THEN** Runtime 请求有限澄清，不执行动作、不猜测数值，也不把输入交给无关能力
