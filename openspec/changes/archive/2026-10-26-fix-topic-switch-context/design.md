# Design

## Decision

在连续恢复入口增加“当前轮是否提供了可验证连续证据”的门禁。旧 route 只在参数收集、明确的动作续改、执行/重试，或已解析的历史指代下恢复；单独的“查询/查一下/可以帮我查询下吧”不再足以恢复上一轮 Function。

## Data Flow

1. semantic.extract 仍接收当前结构化上下文和有界历史。
2. `recoverContinuation` 先判断当前文本是否有显式指代、参数变化或新对象证据。
3. 无连续证据时清除模型可能复述的旧 intent/pluginId，进入正常候选或澄清路径。
4. 有明确新对象时保留当前语义帧；有明确历史指代时继续使用现有 fact/reference 校验。
5. 任何恢复结果继续经过 Function Schema、Policy 和 confirmation，不增加执行授权。

## Compatibility

已有“刚才那张工单”“改成每秒 200 次”“再往上调 50”等连续场景保持不变；改变的只有没有目标、没有指代的泛查询，不再默默读取旧话题。

## Verification

- 新增 scripted 回归锁定普通入口的泛查询澄清、明确新话题路由和显式连续恢复。
- 运行全量测试、build、lint、diff check 和 OpenSpec strict validation。
- 重启 8877/8878 real brain 服务，在一个 Pi session 中重复截图话术，确认不再创建旧工单，并记录真实路由证据。
