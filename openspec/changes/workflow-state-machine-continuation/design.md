# Design

## Context

当前 `semantic.extract` 已经接收 `BehaviorContext`、近期消息、pending action 和已授权 Plugin descriptors，但只返回 semantic frame。`BehaviorContext.workflow` 已保存当前步骤和状态，`collection` 已保存参数收集状态，`confirmation` 已保存确认状态；缺少的是模型事件和 Runtime 转换之间的显式协议。

连续输入不能依赖业务关键词，也不能把 Response Model 的文字当作授权。Function 是执行目标，Plugin 是权限边界：所有恢复出来的标识都必须重新匹配当前启用且已授权的注册表。

## Goals / Non-Goals

**Goals:**

- 让模型知道当前 workflow 位于哪一步、当前允许什么事件以及不允许什么跳转。
- 让 Runtime 根据真实 BehaviorContext 计算权威的下一状态。
- 让参数收集、取消、新话题和确认都通过统一事件处理。
- 让普通和流式 turn 调用同一核心编排器。
- 保持 Function/Plugin 标识、Schema、权限、policy、幂等和 confirmation 的 Runtime 权威。

**Non-Goals:**

- 不以新的简单枚举替换现有 `BehaviorWorkflow`，而是从现有状态派生有界投影。
- 不允许模型提供新的 Function、Plugin、Schema、权限或执行结果。
- 不增加业务实体、业务词或业务专用状态。
- 不增加模型调用次数。
- 不重写已有前端表单控件；后端继续提供结构化 `presentation`。

## Decisions

### 1. 两个维度，而不是一个枚举

模型输出分成两个维度：

```ts
type WorkflowUserIntent =
  | 'start_workflow'
  | 'select_function'
  | 'provide_parameter'
  | 'confirm'
  | 'cancel_workflow'
  | 'new_topic'
  | 'answer_context'
  | 'unknown';

type WorkflowEvent =
  | 'function_selected'
  | 'parameter_received'
  | 'parameter_invalid'
  | 'confirmation_accepted'
  | 'confirmation_rejected'
  | 'workflow_cancelled'
  | 'new_topic'
  | 'unknown';
```

`userIntent` 表达用户想做什么，`event` 表达当前输入对 workflow 造成的事实变化。二者都不能直接执行 Function。

### 2. Runtime 是状态机的唯一权威

Runtime 从 `BehaviorContext.workflow.currentStep/status`、`collection`、`pending` 和 `confirmation` 派生当前状态，并维护允许的转换。模型输出的 `nextState` 如果存在只作为诊断，不作为执行依据；Runtime 重新计算真实的 `nextState`。

基本转换如下：

```text
normal
  -> function_selection | collecting_parameters | pass_through
function_selection
  -> function_selection | collecting_parameters | cancelled | normal
collecting_parameters
  -> collecting_parameters | awaiting_confirmation | cancelled | normal
awaiting_confirmation
  -> executing | collecting_parameters | cancelled | normal
executing
  -> completed | failed
completed | cancelled
  -> normal
```

缺参和非法参数仍处于 `collecting_parameters`，通过 `nextAction=ask_for_parameters` 区分继续收集，不增加业务性质的状态。

### 3. 状态上下文使用有界投影

发送给 semantic.extract 的 workflow context 只包含：状态、允许事件、当前目标的已验证摘要、collection 缺失/非法/冲突字段、pending kind 和 confirmation 状态。不得放入凭据、原始模型 payload、完整执行参数或未授权 descriptor。

### 4. 统一恢复顺序

semantic frame 解析后、semantic incomplete gate 之前执行：

```text
parameter collection
  -> stable verified route
  -> structured clarification
  -> Pi pass_through
```

恢复目标必须精确匹配当前注册表的 Function，并通过 Plugin 启用与授权检查。当前轮具名字段覆盖历史具名字段；未知字段、错误类型、错误枚举和缺失必填字段进入结构化参数澄清。

### 5. 取消和新话题安全清理

`cancel_workflow` 和 `new_topic` 都不会触发执行。Runtime 清理当前 pending action、collection 和 clarification；新话题返回普通路径，明确取消返回 cancelled 结果。为了避免模型把两者混淆，提示词同时提供当前 pending 类型和允许事件，Runtime 对二者做最终归一化。

### 6. 失败关闭和兼容

协议缺失、事件非法、状态跳转非法、目标失效、Plugin 禁用或授权失败时，Runtime 不执行；有安全恢复目标时返回 unavailable/clarification，无安全目标时才允许现有 Pi pass-through。现有 semantic frame 字段和公开 turn status 保持兼容。

## Task Boundaries

1. **Workflow contract and projection**：新增协议、schema、状态投影和转换纯函数；只修改 contracts/runtime 相关文件及其单元测试。
2. **Prompt and adapter**：把真实 workflow context 接入现有 semantic prompt，并解析兼容的结构化 envelope；只修改模型输入/适配层及其测试。
3. **Session integration**：把统一决策接入普通/流式 turn，连接现有 continuation recovery、collector、clarification、cancel 和安全门禁；只修改 session 编排文件及集成测试。
4. **Verification and completion**：补齐跨入口、非法输入、权限失效、模型越权和状态机回归测试，运行全量验证并更新任务清单。

由于任务 1-3 涉及共享状态和同一执行边界，采用主代理串行执行，不并行修改共享文件；每个任务先 RED、再 GREEN、再审计和提交。

## Risks / Trade-offs

- 模型仍可能混淆 `new_topic` 和 `workflow_cancelled`；通过允许事件、当前 pending 类型和 Runtime 归一化减少影响。
- 新 envelope 可能影响旧 provider；保留 semantic frame 兼容解析，并对缺少 workflow decision 做安全的 `unknown` 处理。
- 状态投影与现有 workflow 字段重复；不新增第二个权威状态源，所有转换都基于现有 BehaviorContext 派生。
- 表单展示依赖 Schema presentation；后端只输出经过 schema 校验的字段元数据，前端继续使用现有 renderer。
