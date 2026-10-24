# Spec Delta

## ADDED Requirements

### Requirement: Single-session conversational focus remains bounded

单会话连续测试中，Runtime SHALL 将当前轮明确的新操作或参数变更与历史事实分开处理：历史事实只用于解释指代和回答，不得覆盖当前轮操作；当前轮没有新操作时，回复模型 SHALL 优先使用当前轮明确的对话焦点和取消/失败结果，并在证据不足时澄清而不是串用较早事实。

#### Scenario: Cancelled action remains the immediate conversational focus

- **WHEN** 用户取消权限申请后立即询问“刚才那个申请，提交了吗？”
- **THEN** Runtime/response model 明确回答该申请已取消且未提交，不得将更早或更近的其他成功动作误认为该申请

#### Scenario: New incremental action does not reuse an old absolute value

- **WHEN** 当前轮表达对已验证限流结果的增量修改
- **THEN** 当前轮参数优先，历史结果仅作为计算基线，最终回复和待确认输入都反映合并后的新值
