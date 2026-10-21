# Spec Delta

## MODIFIED Requirements

### Requirement: Package registration is atomic

统一入口 SHALL 在任何 Plugin、Function、输入 Schema、输出 Schema、响应契约或 Handler 校验失败时拒绝整个插件包，并且不得留下部分 Plugin、Function、Handler 或生命周期状态。

#### Scenario: Invalid Function response contract rejects the package

- **WHEN** 插件包中的一个 Function 缺少合法的响应契约、声明未知回复模式或其输入/输出 Schema 不能被编译
- **THEN** 整个插件包注册失败，其他 Function 也不会进入当前路由索引

#### Scenario: One invalid Function rejects the package

- **WHEN** 插件包中的一个 Function 使用未知动作类型或无效输入 Schema
- **THEN** 整个插件包注册失败，其他 Function 也不会进入当前路由索引

#### Scenario: Duplicate identity is rejected

- **WHEN** 一个包内出现重复 `functionId`，或多个已安装版本占用同一不可替换的 Plugin 标识
- **THEN** 注册返回稳定冲突错误，当前注册表保持不变

### Requirement: Unified entry owns lifecycle activation

统一入口 SHALL 接收插件包集合，完成输入/输出 Schema 和响应契约校验、安装和启用；业务方不需要手动维护 `functionIds` 或逐个调用 Host 注册步骤。

#### Scenario: Startup validates custom Function contracts

- **WHEN** 应用启动并加载自定义 Plugin Function
- **THEN** 每个 Function 的 Handler、输入 Schema、输出 Schema 和响应契约在注册提交前完成校验，失败时返回稳定初始化错误且不暴露部分初始化的运行时

#### Scenario: Application starts with registered packages

- **WHEN** 应用通过统一入口传入多个有效 Plugin 包
- **THEN** 入口返回已建立 Plugin 生命周期和 Function 索引的 IAR 运行时

#### Scenario: Startup fails closed

- **WHEN** 任一 Plugin 的依赖、生命周期或 Function 校验失败
- **THEN** 统一入口返回稳定初始化错误，并阻止应用使用部分初始化的路由运行时
