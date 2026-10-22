# Proposal

## Why

当前路由先让模型选择 Plugin、再让模型选择 Function，调用次数和上下文重复导致延迟升高，而且 Plugin 与 Function 的层级关系在模型输入中不够清晰。需要把 Plugin 作为唯一工具边界，以嵌套的 Function/Operation 描述一次性完成候选识别，同时保留运行时对所有模型输出的权威校验。

## What Changes

- 将每个启用 Plugin 投影为一个符合 OpenAI Function Calling 规范的工具，Plugin 内的 Function/Operation 以嵌套结构作为工具参数候选。
- 统一工具名称、参数对象和版本化路由提案，禁止向模型发送跨 Plugin 的扁平 Function 工具列表。
- 将正常路由收敛为一次模型候选调用；模型只负责提出 Plugin、Function、Operation 和具名参数，运行时负责归属、Schema、权限、策略、确认、幂等和执行。
- 对查询类结果继续交给 response.generate 汇总；确认、表单和无回复动作按固定 response mode 跳过最终聊天生成。
- 修正当前含点号工具名不符合 OpenAI 名称约束的问题，并在服务启动或 Plugin 注册时验证工具输入/输出契约。
- 增加嵌套候选规模、参数位置准确性、模型调用次数和端到端耗时测试与基准记录。
- **BREAKING** 新主路由不再向首个模型调用暴露扁平 Function 列表；旧的两阶段决策适配器仅作为显式兼容路径保留。

## Capabilities

### New Capabilities

- `nested-plugin-function-routing`: 定义 Plugin 工具投影、嵌套 Function/Operation 提案、OpenAI 工具契约和一次调用路由行为。

### Modified Capabilities

- `scoped-plugin-routing`: 将 Plugin 优先的两阶段模型路由改为一次嵌套候选路由，并保持 Agent 禁用集和运行时权威校验。
- `function-call-routing`: 扩展 Function Calling 提案，使其同时携带 Plugin、Function、Operation 和具名参数，并要求运行时按安装 Schema 执行校验。

## Impact

- 影响 `packages/plugins` 的 PluginHost 描述投影和注册校验。
- 影响 `examples/agent-sandbox` 的模型传输、路由主链、参数校验、响应模式和耗时观测。
- 影响模型网关集成测试、Sandbox 路由测试及新增基准脚本。
- 不新增外部运行时依赖；继续使用现有 OpenAI-compatible Chat Completions 传输，并兼容 JEV/Intent Model 旧决策适配器。
