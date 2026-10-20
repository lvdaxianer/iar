# Plugin Package Registration

为 IAR 建立以 Plugin 为顶层分发单元、以 Function 为能力单元的注册契约，使一个插件包可以安全地提供多项业务能力，并由统一入口完成可验证的运行时装配。

## Requirements

### Requirement: Plugin package owns Function registrations

业务插件包 SHALL 以唯一 Plugin 标识和版本作为顶层边界，并声明一个有界的 Function 注册集合；每个 Function SHALL 拥有唯一的 `functionId`、固定动作类型、操作目录和执行 Handler。

#### Scenario: One Plugin exposes multiple Functions

- **WHEN** 插件包声明 `ticket.query` 和 `ticket.create` 两个 Function
- **THEN** 两个 Function 都归属于同一个 Plugin，且可分别被索引、路由和执行

#### Scenario: Function is not registered outside its Plugin

- **WHEN** 调用方尝试单独向统一入口注册一个 Function
- **THEN** 入口拒绝没有 Plugin 所有权的 Function 注册，不创建孤立的全局能力

### Requirement: Package registration is atomic

统一入口 SHALL 在任何 Plugin 或其 Function 校验失败时拒绝整个插件包，并且不得留下部分 Plugin、Function、Handler 或生命周期状态。

#### Scenario: One invalid Function rejects the package

- **WHEN** 插件包中的一个 Function 使用未知动作类型或无效输入 Schema
- **THEN** 整个插件包注册失败，其他 Function 也不会进入当前路由索引

#### Scenario: Duplicate identity is rejected

- **WHEN** 一个包内出现重复 `functionId`，或多个已安装版本占用同一不可替换的 Plugin 标识
- **THEN** 注册返回稳定冲突错误，当前注册表保持不变

### Requirement: Function candidates derive from installed Plugin packages

运行时 SHALL 从已安装且启用的业务 Plugin 包构建 Function 候选；系统 Plugin 和未启用 Plugin 的 Function 不得进入业务候选。

#### Scenario: Disabled package is absent

- **WHEN** Plugin 已安装但处于 disabled 状态
- **THEN** 其所有 Function 都不会出现在 Function 或 Plugin 决策候选中

#### Scenario: Multiple providers share a Function

- **WHEN** 两个启用 Plugin 都声明 `ticket.query`
- **THEN** Function 阶段只看到一个有界的 `ticket.query` 能力，Plugin 阶段只看到这两个归属正确的实现候选

### Requirement: Unified entry owns lifecycle activation

统一入口 SHALL 接收插件包集合，完成校验、安装和启用；业务方不需要手动维护 `functionIds` 或逐个调用 Host 注册步骤。

#### Scenario: Application starts with registered packages

- **WHEN** 应用通过统一入口传入多个有效 Plugin 包
- **THEN** 入口返回已建立 Plugin 生命周期和 Function 索引的 IAR 运行时

#### Scenario: Startup fails closed

- **WHEN** 任一 Plugin 的依赖、生命周期或 Function 校验失败
- **THEN** 统一入口返回稳定初始化错误，并阻止应用使用部分初始化的路由运行时

### Requirement: Function execution context is scoped

Function Handler SHALL 只接收 JSON 输入和包含当前 `pluginId`、`functionId`、会话/运行标识及关联标识的只读上下文；Handler 不得通过上下文修改注册表或授权边界。

#### Scenario: Handler receives both identities

- **WHEN** 路由选择某个 Plugin 下的 Function 并执行 Handler
- **THEN** Handler 同时收到真实的 `pluginId` 和 `functionId`，且二者与当前注册关系一致

#### Scenario: Handler cannot expand authority

- **WHEN** Handler 返回额外能力或尝试改变注册表上下文
- **THEN** 运行时忽略或拒绝未声明的权限变化，执行边界仍以已校验的 Plugin/Function 契约为准
