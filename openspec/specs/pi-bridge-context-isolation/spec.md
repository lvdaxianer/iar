# Pi Bridge Context Isolation

## Purpose

保证 IAR 通过 Pi 扩展返回的业务结果能够被用户看到，同时不会改变 Pi 后续 Agent 调用所使用的模型上下文，从而维持两套会话的职责边界。

## Requirements

### Requirement: IAR 结果必须与 Pi 模型上下文隔离

Pi 扩展 SHALL 将非 pass-through 的 IAR 结果作为仅供界面展示的内容提供给用户，并且该结果不得进入 Pi 后续 LLM context。

#### Scenario: IAR 处理请求并返回业务结果

- **WHEN** IAR 返回 `handled` 或 `awaiting_confirmation` 结果
- **THEN** 用户能够在 Pi 交互界面看到 IAR 的回复和处置状态
- **AND** Pi 后续 Agent 调用的消息上下文不包含该 IAR 展示条目

#### Scenario: 用户确认或取消待执行动作

- **WHEN** 用户执行 `iar-confirm` 或 `iar-cancel`
- **THEN** 确认结果能够在 Pi 界面展示
- **AND** 确认结果不进入 Pi 后续 LLM context

### Requirement: 展示内容必须受控

Pi 扩展 SHALL 对 IAR 展示内容进行有限长度和终端安全处理，且展示失败不得改变 IAR 请求的业务处置结果。

#### Scenario: IAR 返回过长或包含控制字符的内容

- **WHEN** 扩展收到超过展示上限或包含终端控制字符的 IAR 回复
- **THEN** Pi 仅展示经过限制和清理的内容
- **AND** 扩展不会将原始内容写入 Pi 模型上下文

### Requirement: 桥接行为保持向后兼容

上下文隔离修复 SHALL 保持既有输入路由、会话映射、确认状态和故障降级行为不变。

#### Scenario: IAR 判定请求应放行给 Pi

- **WHEN** IAR 返回 `pass_through`
- **THEN** Pi input hook 返回继续处理
- **AND** 扩展不创建 IAR 展示条目

#### Scenario: IAR 桥接不可用

- **WHEN** Pi 扩展无法建立或继续使用 IAR Bridge
- **THEN** 扩展按照既有配置返回 `handled` 或 `continue`
- **AND** 不因展示层改造而抛出未处理异常

### Requirement: Pass-through carries the current capability context

When IAR returns `pass_through`, the Bridge response SHALL optionally carry a
bounded catalog of the current Agent's enabled and authorized Function/Plugin
descriptions for the downstream Pi Host model. The catalog SHALL be context
data only and SHALL not authorize an IAR action.

#### Scenario: Pi Host receives enabled capability context

- **WHEN** IAR does not match a Function and returns `pass_through`
- **THEN** the Bridge response contains the current enabled capability descriptions and the Pi Host can include them in the next model input

#### Scenario: Disabled capability is not exposed

- **WHEN** a Plugin is disabled in the Agent configuration before a pass-through request
- **THEN** its Function and Plugin descriptions are absent from the Bridge context

#### Scenario: Legacy response remains valid

- **WHEN** a Pi client receives a pass-through response without the optional capability context
- **THEN** it continues the existing Pi handling path without treating the missing field as an error

#### Scenario: Capability context cannot execute actions

- **WHEN** the downstream Pi model receives the pass-through capability context
- **THEN** it may use the descriptions to answer the user but IAR still requires a new bridge request and normal routing/policy gates for any business execution
