# Design

## Context

See `proposal.md` for motivation and the delta specs for observable behavior. 当前 PluginHost 已能枚举 Plugin 和 Function/Operation，但向模型投影时使用扁平 Function 工具名；Sandbox 路由仍存在先判断 Plugin、再调用 Function 的链路。模型传输使用 OpenAI-compatible Chat Completions，运行时已有 JSON Schema、权限、策略、确认和 response mode 校验。

## Goals / Non-Goals

**Goals:**

- 让一次路由模型调用同时完成 Plugin、Function、Operation 和具名参数提议。
- 让每个 Plugin 成为一个 OpenAI-compatible tool，保持 Plugin 是能力边界，Function 是 Plugin 内部动作能力。
- 在模型输出进入 Action/Handler 前完成确定性的归属、Schema、授权、策略和确认校验。
- 兼容 JEV 和 Intent Model 旧 Function-call 适配器，并允许通过明确配置回退，不让旧路径污染主路径。
- 记录单次路由与 response.generate 的阶段耗时、模型角色、调用次数和 traceId，而不记录 prompt、response 或密钥。

**Non-Goals:**

- 不让模型直接执行 Function，不把模型返回的 Plugin/Function 名称当作权限。
- 不改变已有 Function Handler 的业务语义、response mode 或确认策略。
- 不在本变更中增加新的外部日志平台或持久化依赖。
- 不要求对所有历史 JEV profile 立即删除；旧适配器只保留为显式兼容路径。

## Decisions

### 1. Plugin tool uses a nested, schema-valid argument object

每个工具使用稳定的合法名称，例如 `plugin_<safe-id>`，名称通过 ASCII、数字、`_`、`-` 和 64 字符上限校验。工具参数是 JSON object，包含 `functionId`、`operation` 和 `arguments`；Function 的 input Schema 仍作为嵌套候选的受控描述，不允许模型提交新的 Schema。

之所以不使用 `oneOf`/`const` 等可能被供应商拒绝的 Schema 关键词，是为了兼容当前 OpenAI-compatible provider 的实际支持范围。Function 的业务参数仍放在命名的 `arguments` 对象中，避免依赖位置或数组顺序。

**Alternatives considered:**

- 扁平化所有 Function：传输简单，但破坏 Plugin 边界、造成候选数量增长，并且当前点号名称不符合 OpenAI 名称规范。
- 先 Plugin 再 Function 两次调用：边界清晰，但延迟和失败面更大；本变更的实测结果显示一次嵌套调用足以保持参数准确性。
- 用 `oneOf` 为每个 Function 建联合 Schema：表达力更强，但当前 provider 已返回 400，不能作为默认传输格式。

### 2. Model proposes; runtime resolves and validates

模型只产生工具调用提案。适配器将工具名映射回原始 Plugin，再解析 `functionId`、`operation` 和具名 `arguments`。运行时从当前 PluginHost 重新解析注册记录，检查启用状态、所有权、输入 Schema、权限、策略、确认和幂等；任何一项失败都不会调用 Handler。

### 3. One route call plus optional response generation

主路由使用一次 `semantic.extract`/nested route proposal。查询或 `model` response mode 的 Function 结果进入一次 `response.generate`；确认、表单和 `none` 结果不生成普通聊天文本。路由调用使用统一 DeepSeek normal interaction model，发送 `thinking: {type: "disabled"}`；JEV/Intent Model 仅在兼容模式或显式路由配置中使用。

### 4. Contract validation runs at registration and request boundaries

PluginHost 注册时校验工具名称、Function/Operation 标识、input/output Schema 和 response mode；模型请求构造前再次校验投影结果；模型返回后校验版本化提案。这样既能在启动时尽早发现自定义 Plugin 错误，也能防止运行时注册变化绕过边界。

### 5. Compatibility is isolated

保留现有 `function.call` 决策适配器和旧平面工具转换，仅由兼容路由显式调用。新主路由使用独立的 nested tool adapter，不能在新路径中悄悄回退到 mock JEV；JEV 未配置时按现有契约回退到 Intent Model，但统一路由默认不触发额外的第二次选择调用。

## Risks / Trade-offs

- [Provider schema support] 不同 OpenAI-compatible provider 支持的 JSON Schema 子集不同 → 使用保守 object/properties/required/enum/additionalProperties 子集，并在启动验证和模型网关测试中拒绝不兼容 Schema。
- [Tool payload size] Plugin 或 Function 数量增长会增加首包和延迟 → 以 Plugin 为工具边界、限制描述长度、在基准脚本中按 1/5/10/20/40 Plugin 测量，超过阈值记录告警并保留候选上限。
- [Parameter accuracy] 模型可能把值放错字段 → 参数必须是命名 JSON object，运行时按安装 Schema 严格验证；失败只产生 clarification，不执行。
- [Compatibility] 旧测试和 JEV profile 仍使用扁平工具 → 保留旧 adapter 的明确测试，主路由测试断言只发生一次 nested proposal 调用。
- [External model failure] 路由模型超时或返回非法 tool call → 使用现有稳定错误契约、阶段耗时和 traceId，不把模型异常伪装成业务错误。
- [Security] 自定义 Plugin 可能声明过宽 Schema 或敏感描述 → 注册时限制 Schema/描述长度，日志只记录安全元数据；运行时继续执行授权、策略和确认校验。

## Migration Plan

1. 先加入契约类型、名称归一化和注册验证，不改变现有路由行为。
2. 增加 nested tool adapter 和模型传输测试，默认主路由切换到 nested proposal；旧路由由兼容开关保留。
3. 迁移 Sandbox 主链、查询/动作/确认/自我介绍测试和 timing 字段，完成基准后再移除默认旧路径依赖。
4. 若线上 provider 不支持 nested schema，可关闭 nested 主路由开关回到兼容路径；已注册的 Function Handler 和已有 session 状态不需要迁移。
