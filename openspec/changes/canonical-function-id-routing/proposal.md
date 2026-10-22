# Proposal

## Why

当前模型可以理解“帮我创建一张工单”，但运行时仍可能用自然语言 `创建工单` 去匹配规范 Function ID `ticket.create`，造成合法路由被判定为 `plugin_rule_not_matched`。路由失败后又进入 `response.generate` 兜底路径，既产生错误回复，也把一次请求的耗时拉长到接近 8 秒。

## What Changes

- 要求路由模型从当前有限的 Plugin/Function 工具集合中返回稳定的 `plugin_id`、`function_id` 和 `operation`。
- 将自然语言意图与规范路由身份分离；程序规则只使用已注册的规范 ID，不再使用自然语言意图比较 Function。
- 在运行时重新校验 Plugin 所有权、启用状态、授权、Operation、输入 Schema、Policy、确认和幂等性。
- 保留已选 Plugin/Function 的拒绝证据，避免 UI 显示 Function 有值但 Plugin 为空。
- 只有没有合法 ID、信息不足、能力关闭或模型/桥接失败时才进入兜底回答。
- 查询类 Function 的结果继续交给 Response Model 汇总；待确认或 UI-only 动作不额外伪造模型回复。
- 兼容决策路径在 JEV 三项配置不完整时只保留 Intent Model；显式选择未配置的 JEV 时启动即 fail-fast。
- JEV 三项配置完整时，JEV profile 必须绑定真实 JEV provider；本地 mock 只允许用于离线测试和 scripted 模式，不能冒充生产 JEV。
- 增加自然语言到规范 ID、错误分类、参数位置、Plugin 关闭和耗时回归测试。

## Capabilities

### New Capabilities

无。该变更修正并收紧现有嵌套 Plugin/Function 路由能力。

### Modified Capabilities

- `nested-plugin-function-routing`: 明确模型输出的规范 Plugin/Function/Operation 身份是运行时路由校验的唯一候选身份。
- `function-call-routing`: 明确规范 ID 与命名参数必须在进入 Action 前经过有限集合和已安装 Schema 校验。
- `scoped-plugin-routing`: 明确自然语言语义只用于模型理解，不能替代 Plugin/Function 的规范归属判断。

## Impact

- 运行时路由：`packages/runtime/src/routing.ts`。
- 模型输入和工具契约：`examples/agent-sandbox/src/models/model-input-transport.ts`、`packages/runtime/src/intent/decision/model-gateway/function-call.ts`。
- Sandbox 路由规则与错误展示：`examples/agent-sandbox/src/session-routing.ts` 及其适配测试。
- 测试：路由、Function Calling、Sandbox 集成和耗时观测测试。
- 不新增外部依赖，不改变 Plugin Handler 的执行权限，不改变已有 `iar.function-call/v1` 版本。
