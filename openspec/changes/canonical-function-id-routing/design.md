# Design

## Context

当前嵌套路由已经把每个业务 Plugin 投影为一个受限工具，模型可以在一次调用中提出 Plugin、Function、Operation 和参数。但后续插件规则评估仍然读取原始 `facts.semantic.intent`，而该字段可能是自然语言“创建工单”，规则却要求 `ticket.create`。这使模型已经提出的合法规范身份没有成为程序校验的输入。

## Goals / Non-Goals

**Goals:**

- 让模型输出稳定、可校验的 `plugin_id/function_id/operation`。
- 让程序使用注册表和已安装 Schema 固定判断模型输出是否合法。
- 保留现有授权、能力、Policy、确认和幂等性门禁。
- 修复合法路由误入兜底模型导致的额外耗时。
- 让拒绝结果完整保留 Plugin、Function 和明确 reason code。

**Non-Goals:**

- 不让模型直接执行 Function 或授予自己权限。
- 不把自然语言意图从会话上下文中删除；它仍可用于上下文回答、日志摘要和模型理解。
- 不在本变更中更换 `semantic.extract`、`function/plugin.select` 或 `response.generate` 的模型配置。
- 不在没有实测证据的情况下合并所有模型调用；调用次数优化只以测试结果为依据。

## Decisions

### 1. 规范 ID 是路由身份

模型只能从当前请求携带的有限工具定义中选择规范 ID。推荐的路由提议结构为：

```json
{
  "plugin_id": "ticket-support-v1",
  "function_id": "ticket.create",
  "operation": "create",
  "arguments": {
    "description": "会议室投影仪连不上",
    "priority": "high"
  },
  "confidence": 0.97
}
```

`semantic.intent` 继续保存自然语言或语义标签，但不再作为 Plugin/Function 所有权的唯一判断依据。

### 2. 运行时做两层校验

第一层验证模型输出是否属于当前有限工具集合：工具名、Plugin、Function、Operation 和参数对象必须存在且格式正确。第二层使用当前 PluginHost 重新解析注册记录，并检查启用状态、授权、能力、Policy、确认、幂等性和输入 Schema。任何一层失败都不得创建或执行 Action。

### 3. 嵌套路由使用规范身份评估规则

`routeNestedProposalAsync` 在模型提议已经通过工具和注册表解析后，使用提议中的 `plugin_id/function_id` 构造本次插件规则评估所需的规范身份视图。该视图只用于当前规则评估，不回写原始会话事实，也不绕过规则中的其他条件。

### 4. 回复路径按 Function 结果类型分流

- `query/read`：执行后将有界结果交给 `response.generate` 汇总。
- `action/create/update`：先走参数和风险确认；待确认状态不额外调用回复模型，确认执行后的结果按 Function response contract 决定是否汇总。
- `direct/none`：使用已校验的直接结果或 UI 状态，不调用回复模型。
- 无合法规范 ID或请求不完整：进入澄清/兜底回答，不执行 Function。

### 5. 性能验证分两步

先修正误路由，确认不再因 `plugin_rule_not_matched` 触发额外 `response.generate`。然后用真实模型测试 `semantic.extract`、路由提议、执行和回复阶段的 P50/P95；只有测试证明安全且准确率不下降，才评估合并模型调用。

## Risks / Trade-offs

- [模型返回合法 ID 但语义选择错误] → 维持有限工具集合、置信度、澄清阈值和程序侧最终门禁。
- [Function ID 在不同 Plugin 中重复] → Plugin ID 与 Function ID 必须成对校验，不能只靠 Function ID 全局查找。
- [规则依赖自然语言字段] → 规范身份只覆盖当前插件身份字段，其他规则事实保持原样；迁移规则时明确使用稳定 ID。
- [错误路径仍然慢] → 通过阶段 Timing 和 Trace ID区分模型、桥接、执行和兜底回复耗时，不用总耗时推测根因。

## Migration Plan

1. 先增加失败回归测试，复现自然语言意图与规范 ID不一致时的误判。
2. 实现规范身份校验和嵌套路由规则评估修复。
3. 补齐错误类型、Plugin 证据和查询/动作回复分流测试。
4. 运行 focused tests、`npm run lint`、`npm run build` 和 `npm test`。
5. 使用 Sandbox 验证“创建工单”进入确认流程且不再输出“能力不可用”；记录总耗时和各阶段耗时。

## Open Questions

无。Function ID 是模型与程序之间的稳定路由协议，Plugin ID 负责所有权和授权边界。
