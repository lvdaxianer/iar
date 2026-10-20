# Design

## Context

当前仓库已经具备版本化契约、PluginHost 生命周期、Function/Plugin 两阶段路由、会话状态投影和 Pi Bridge。现有问题集中在注册模型：业务 Plugin Manifest 直接持有单个 `functionId`、操作目录、输入输出 Schema 和 Handler，导致 Plugin 只能表示一个 Function。详见 `proposal.md` 及本变更的 delta specs。

本次是未发布项目的破坏性切换，不保留旧 `FunctionPluginManifest`、旧 `PluginRegistration` 形状或 `PluginHost({ functionIds })` 兼容层。

## Goals / Non-Goals

**Goals:**

- 建立 `Plugin > Function > Operation` 的稳定公共模型。
- 让一个 Plugin 包含多个 Function，并允许多个 Plugin 提供同一 Function 的实现。
- 提供 `@iar/plugin` 定义 SDK 和 `@iar/agent` 统一运行时入口。
- 从已安装 Plugin 包自动建立 Function 索引，不再由调用方维护 `functionIds`。
- 保持意图识别、Function-first 两阶段决策、动态候选范围、最终 Host 重验证、策略确认、会话上下文和 Pi Bridge 行为不变。
- 让包、示例、测试和架构文档都使用同一套注册方式。

**Non-Goals:**

- 不修改 Pi 仓库或 Pi 的扩展机制。
- 不重新设计 Intent Model、JEV、会话持久化或 Workflow 状态机。
- 不引入远程插件下载、签名分发协议或跨进程 Handler 执行协议。
- 不允许模型直接选择未由当前 Plugin 包索引出来的 Function 或 Plugin。

## Decisions

### 1. Plugin Manifest 只描述包级边界，Function 描述能力级边界

`@iar/contracts` 将业务 Manifest 改成包级字段：`pluginId`、版本、描述、能力、生命周期、策略和依赖；删除 Manifest 上的 `functionId`、`actionTypes`、`operations`、`inputSchema` 和 `outputSchema`。`FunctionDefinition` 保留这些能力级路由和数据字段。

`@iar/plugins` 新增运行时注册形状：

```ts
type FunctionRegistration = {
  definition: FunctionDefinition;
  operations: readonly PluginOperation[];
  handler: FunctionHandler;
};

type PluginPackage = {
  manifest: PluginManifest;
  functions: readonly FunctionRegistration[];
};
```

理由：公共 Schema 和 Handler 都属于 Function；Plugin 负责包级生命周期、依赖和能力集合。相比把所有 Function 再复制进 Manifest，这种形状避免声明与实现双份漂移，同时允许本地运行时保留不可序列化的 Handler。

替代方案：继续让 Manifest 携带单个 Function 字段会保留旧层级；把 Handler 挂在 Plugin 上会无法表达多个 Function 的不同执行入口，均不采用。

### 2. SDK 和 Host 分离，但应用只使用一个统一入口

- `@iar/plugin`：只负责 `defineFunction`、`definePlugin` 和插件作者所需的公共类型/校验组合。
- `@iar/plugins`：负责 `PluginHost`、`FunctionRegistry`、生命周期和运行时候选描述。
- `@iar/agent`：负责接收 `PluginPackage[]`，创建 Host，批量安装并启用，返回统一 Agent 运行时依赖。

理由：插件作者不必依赖完整 Agent；业务应用只需从 `@iar/agent` 进入，不需要手动协调 Host 和 FunctionRegistry。`@iar/plugin` 的构建产物只依赖公开包入口。

### 3. FunctionRegistry 从 PluginHost 派生，不维护第二份授权状态

Host 保存 Plugin 包生命周期和 Function 注册内容。`FunctionRegistry` 只建立从 `functionId` 到当前 Plugin Function 提供者的只读索引，并在 Host 生命周期变化时更新。启用、禁用、卸载和授权过滤均以 Host 当前记录为准，避免索引成为第二个权威源。

同一 `functionId` 可以有多个 Plugin 提供者；索引值是有序提供者列表。系统 Plugin 没有业务 Function，永远不进入索引。

### 4. 路由协议保持 Function-first

`TwoStageRouter` 的外部请求、决策类型、候选约束、`DecisionResult`、澄清状态和最终 `resolveCandidate(functionId, pluginId)` 语义不变。改造点只有：

1. Function 候选从 `FunctionRegistry` 读取；
2. Plugin 候选从已选 Function 的提供者列表读取；
3. Handler、操作目录、输入输出 Schema 从所选 Plugin 的嵌套 Function 记录读取；
4. 最终重验证同时确认 Plugin 已启用、Function 仍归属于该 Plugin、能力和策略仍满足。

这样“模型层级”是 `Plugin > Function`，而“路由决策顺序”仍是 `Function → Plugin`，满足行为不变约束。

### 5. 统一入口的启动事务

`createIarAgent({ plugins, ...runtimeOptions })` 按以下顺序执行：

```text
校验输入数组和 Plugin 包身份
  → 校验每个 Function definition、operations、handler
  → 校验 Plugin 级能力/策略/依赖
  → 原子 installAll
  → 按依赖顺序 enableAll
  → 构建 FunctionRegistry
  → 返回 agent { pluginHost, functionRegistry, routerDependencies }
```

任一步失败都释放本次创建的 Host，不返回部分可用 Agent。运行时 Handler 不在启动时执行。

### 6. Pi 和会话边界

`@iar/pi-bridge` 继续作为输入/输出适配器，只调用 Agent 暴露的 IAR 会话服务。IAR 的 `SessionManager`、BehaviorContext、确认状态和持久化仍是唯一会话权威；Plugin Function Handler 只能接收只读执行上下文。此变更不修改 Pi 源码和 Pi extension API。

## Risks / Trade-offs

- [Risk] 大量旧测试和示例直接读取 `manifest.functionId`。→ 在本次破坏性迁移中统一改为 `plugin.functions[].definition.functionId`，新增包级测试覆盖禁止旧字段。
- [Risk] FunctionRegistry 与 Host 生命周期不同步会产生陈旧候选。→ Registry 只由 Host 生命周期事件驱动更新，路由最终仍通过 Host 当前记录重验证。
- [Risk] 一个 Plugin 内多个 Function 的能力/策略边界可能被误合并。→ Function 保留自己的 schema、actionTypes、riskLevel 和 operations；Plugin policy 只能是上界，安装时验证 Function 能力属于 Plugin 能力集合。
- [Risk] 批量安装失败后残留部分记录。→ 先完成全量校验和依赖排序，再一次性提交安装；为失败路径增加原子性回归测试。
- [Risk] 新增包发布配置与现有 workspace project references 不一致。→ 增加构建、类型解析和 package distribution smoke tests，并在干净 worktree 运行完整测试。

## Migration Plan

1. 先新增失败测试，锁定 `PluginPackage`、多 Function 注册、统一入口、重复身份和启动原子性。
2. 重构 contracts、plugins SDK/Host 和 runtime candidate projection。
3. 新增 `@iar/plugin`、`@iar/agent` 包并接入 workspace/build references。
4. 迁移 sandbox、examples、fixtures 和所有测试到新注册模型。
5. 更新架构、插件/Function 定义、统一入口、Pi 集成文档。
6. 运行完整 build/test/distribution checks，完成 code review 和 OpenSpec 校验。

由于用户明确要求不保留历史包袱，不提供运行时兼容适配层；回滚仅通过 Git 回退整个 change 分支完成。
