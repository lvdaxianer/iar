# Proposal

## Why

IAR 当前把能力描述分散在各个 Plugin 的 Function 定义和沙箱兜底话术中，无法让 Agent 以自身真实的可用能力完成统一自我介绍。需要把“自我介绍”建模为一个内置 Plugin，使意图模型先选择该能力，再由 Plugin 汇总当前 Agent 的可用 Plugin 描述交给回复模型生成答案。

## What Changes

- 新增内置 `self-introduction` Plugin，拥有一个可路由的自我介绍 Function。
- 为业务 Plugin 的 Function 描述增加稳定的介绍元数据投影，汇总时只读取当前 Agent 中已启用且可路由的能力。
- 扩展 `createIarAgent`/`createIarRuntime` 的创建配置：默认装配自我介绍 Plugin，允许创建 Agent 时关闭指定业务 Plugin，并保存自我介绍补充提示词。
- 关闭的 Plugin 不进入该 Agent 的意图候选、执行宿主或自我介绍汇总；新 Plugin 在未明确关闭时默认加入。
- 自我介绍 Plugin 返回结构化能力目录与补充提示词，由回复模型生成最终自然语言；运行时不把模型生成文本当作授权依据。
- 更新沙箱的离线意图与回复路径，覆盖 `hi`、`你好`、`你能做什么` 等自我介绍输入，并保留真实模型路径的 Plugin 描述输入。

## Capabilities

### New Capabilities

- `self-introduction-plugin`: 内置自我介绍能力、Agent 级 Plugin 筛选及补充提示词汇总。

### Modified Capabilities

- `standalone-intent-runtime`: Agent 创建配置决定默认 Plugin 集合、禁用 Plugin 和自我介绍提示词。
- `scoped-plugin-routing`: 当前 Agent 的禁用 Plugin 必须在意图候选和最终执行前统一生效。
- `structured-model-context`: 回复模型接收由自我介绍 Plugin 生成的结构化能力目录，不接收未经验证的执行权限。

## Impact

- `@iar/plugins`：内置 Plugin、描述投影和 Agent 级候选过滤。
- `@iar/runtime`：Runtime 创建配置、默认 Plugin 装配和配置快照。
- `examples/agent-sandbox`：离线语义识别、动作输入、回复生成和 Agent 创建配置。
- 契约/路由/模型上下文测试与 OpenSpec 规格。
- 不新增独立页面；配置通过创建 IAR Agent 的运行时选项传入并持久保留在 Agent 配置中。
