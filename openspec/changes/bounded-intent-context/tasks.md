# Tasks

## 1. Context budget primitive

- [x] 1.1 新增纯函数上下文预算模块，定义 24,000 字符总上限、必需层与可裁剪层、完整单元裁剪规则和不含原文的诊断结构；通过新增单元测试验证当前消息与当前 workflow 状态优先保留、较旧历史按顺序移除、输出仍是合法 JSON。
- [x] 1.2 为必需层超过总预算增加稳定 fail-closed 结果，并通过单元测试验证不会返回半截 JSON 或静默删除候选边界。

## 2. Intent prompt integration

- [x] 2.1 将 semantic.extract 的 Prompt 组装接入统一预算模块，保留现有分栏、引用 scope 和候选授权边界；通过语义 Prompt 集成测试验证长会话裁剪和当前消息优先级。
- [x] 2.2 将 function.select 与 plugin.select 的 Intent Model 输入接入统一预算模块；通过 intent-prompt 和 decision adapter 测试验证候选顺序、structured context、recent messages 和预算失败语义不变。

## 3. Safe diagnostics

- [x] 3.1 为 ModelGateway invocation 增加仅供 audit 的预算诊断快照，并在现有脱敏 audit metadata 中记录大小、裁剪标志和有限层计数；通过 audit 测试验证不出现用户原文、完整 Prompt、候选 ID 或凭证。
- [x] 3.2 为 semantic.extract 与 Intent Model 的正常、裁剪、预算失败和 provider fallback 路径补齐稳定观测测试；验证观测回调失败不会改变主流程结果。

## 4. Long-session verification

- [ ] 4.1 新增长会话意图识别集成场景，覆盖 20～40 轮上下文、当前参数覆盖旧参数、相对追问、预算裁剪和模型失败 fallback；通过新增集成测试验证 fail-closed 行为。
- [ ] 4.2 运行受影响的 model-gateway、session persistence、workflow evaluation 测试以及完整 `npm test`，并完成 OpenSpec 验证、代码审查和最终差异审计。

## Workflow follow-up

- 每个任务完成 RED、GREEN、相关测试、审计和中文 Conventional Commit 后，合并回 `master` 再开始下一个任务。
- 所有任务完成并通过最终审计后归档 `bounded-intent-context` change。
