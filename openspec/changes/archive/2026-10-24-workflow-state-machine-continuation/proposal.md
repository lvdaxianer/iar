# Proposal

## Why

IAR 已经保存了已验证的路由、参数收集和确认状态，但模型在连续补充、取消填写或切换话题时只返回不完整语义帧，运行时缺少统一的事件和状态转换协议，容易把仍可安全恢复的请求错误地交给 Pi，或让自然语言回复影响执行路径。

本次变更把模型识别的用户事件与 Runtime 权威状态转换分离，并让普通入口和流式入口共享同一套状态机、恢复、参数收集和安全门禁。

## What Changes

- 增加通用、版本化的 workflow decision 协议，描述用户意图和当前事件，不授予执行权限。
- 将当前 BehaviorContext 投影为有界的 workflow context，并把当前状态及允许转换提供给语义模型。
- 由 Runtime 校验事件、计算下一状态并拒绝非法状态跳转；模型不能直接指定可执行状态或创建 Function/Plugin 标识。
- 在 semantic incomplete gate 之前恢复参数收集目标和已验证路由，恢复后继续经过 descriptor、Schema、权限、policy、幂等和 confirmation 门禁。
- 统一普通 turn 与 streamed turn 的处理核心，保证路由证据、状态和安全边界一致。
- 支持结构化参数澄清、用户取消填写和切换新话题，并安全清理 pending/collection 状态。
- 继续只向模型提供当前启用且已授权的 Plugin descriptors；Plugin 权限仍是授权来源，Function 是执行目标。
- 增加协议、转换、恢复、参数合并、取消、不可用目标和普通/流式一致性测试。

## Capabilities

### New Capabilities

- `workflow-event-protocol`: 为模型事件识别和 Runtime 状态转换提供通用、版本化、非授权协议。

### Modified Capabilities

- `behavior-state`: 保存和投影 workflow 状态转换所需的当前步骤、事件和安全清理结果。
- `continuation-recovery`: 在不完整语义帧进入 pass-through 前恢复已验证的 Function/Plugin 与参数收集上下文。
- `structured-model-context`: 向 semantic.extract 提供当前状态、允许转换和有限上下文，并保持模型输出非权威。

## Impact

- 影响 contracts、runtime、agent-sandbox 的 semantic prompt、session turn、路由恢复和参数收集代码。
- 影响 semantic.extract 的结构化输出解析，但保持现有 semantic frame 兼容字段。
- 影响 BehaviorContext 的状态投影和安全诊断，不改变已有 Function handler、权限、policy、幂等和 confirmation 执行契约。
- 不新增业务关键词、业务专用分支、额外模型调用或新的外部依赖。
