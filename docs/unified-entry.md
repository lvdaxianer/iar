# 统一入口和包注册

## 插件作者入口

插件包从 `@iar/plugin` 导入两个作者 API：

```ts
import { defineFunction, definePlugin } from '@iar/plugin';
```

`defineFunction` 只定义 Plugin 内的一项能力，包含：

- Function definition：`functionId`、Schema、动作类型、能力和风险等级
- Operation 目录：Function 支持的具体动作
- Handler：接收 JSON 输入和只读上下文的执行函数

`definePlugin` 将一个或多个 Function 绑定到 Plugin Manifest。Plugin 是 Function 的唯一所有者；不能直接向全局 Host 注册孤立 Function。

## 应用统一入口

应用从 `@iar/runtime` 导入 `createIarRuntime`。旧的 `createIarAgent` 仅作为迁移期 deprecated alias 保留：

```ts
import { createIarRuntime, type AsyncDecisionAdapter } from '@iar/runtime';
import { ticketPlugin } from './ticket-plugin.js';

const decisionProvider = {
  decide: async () => ({
    ok: false,
    error: { code: 'model.no_profile', message: '决策模型 backend 未配置', retryable: false, details: {} },
    audit: [],
    events: [],
  }),
} satisfies AsyncDecisionAdapter;

const iar = createIarRuntime({
  plugins: [ticketPlugin],
  decisionProvider,
  disabledPluginIds: ['ticket-plugin-id'],
  selfIntroduction: { extraPrompt: '先给结论，再列出能力' },
});
```

Runtime 会自动加入内置 `iar.self-introduction` Plugin。用户在创建 Agent 时通过
`disabledPluginIds` 关闭外部 Plugin，通过 `selfIntroduction.extraPrompt` 配置只作用于
自我介绍回复的额外提示词；两项配置都会固化在返回值的 `configuration` 快照中。
内置自我介绍 Plugin 不允许关闭，未知关闭项会让 Agent 初始化失败。自我介绍意图命中后，
Runtime 将当前已启用 Plugin 的描述交给该 Function，再把结构化执行结果交给回复模型。

初始化过程为：

```text
PluginPackage[]
  → 完整契约校验
  → 依赖排序
  → 原子安装
  → 按依赖启用
  → 派生 FunctionRegistry
  → 返回 PluginHost + FunctionRegistry + DecisionProvider
```

任一 Plugin、Function、依赖或启用步骤失败，初始化失败并清理本次安装，不返回部分可用的 Agent。

返回值：

```ts
type IarRuntime = {
  pluginHost: PluginHost;
  functionRegistry: FunctionRegistry;
  decisionProvider: AsyncDecisionAdapter;
  configuration: {
    disabledPluginIds: readonly string[];
    selfIntroduction: { extraPrompt?: string };
  };
};
```

`pluginHost` 负责生命周期；`functionRegistry` 用于读取当前启用的 Function 和 Plugin providers。Registry 绑定 Host 的当前记录，禁用或卸载 Plugin 后，相关 Function 不会继续作为当前 provider 返回。

## 发布和导入边界

```text
插件项目  → @iar/plugin → 导出 PluginPackage
应用项目  → @iar/runtime  → createIarRuntime({ plugins, decisionProvider })
运行时    → @iar/plugins → PluginHost / FunctionRegistry
```

消费者只依赖包根入口：

```ts
import { definePlugin } from '@iar/plugin';
import { createIarRuntime } from '@iar/runtime';
```

两个包都发布自身 `dist/index.js` 和 `dist/index.d.ts`，不依赖仓库根目录、其他包的 `src` 或未声明内部路径。决策实现、规则、Workflow、观测和 Session 都属于 runtime 内部实现，不再作为独立发布包。

## HTTP 和 Pi 接入边界

业务 Handler 是 JavaScript 函数，不能通过 JSON 传输。因此业务 Plugin 必须在应用进程内通过模块导入注册；HTTP/Service API 不能伪装成业务包安装入口。

Pi 不需要导入 Plugin SDK，也不需要修改 Pi 源码。Pi 只调用 `@iar/pi-bridge` 暴露的 IAR 会话接口，IAR 负责会话、意图识别、有限候选、动态路由、确认和 Handler 执行；Bridge 不拥有 PluginHost、FunctionRegistry 或 Session。

## 失败和安全约束

- 重复 Plugin ID 或 Function ID：拒绝注册。
- Function capability 超出 Plugin capability：拒绝注册。
- 未知 action type、无效 Schema 或无 Handler：拒绝整个 Plugin 包。
- System Plugin：只能显式生命周期管理，不能进入业务路由。
- 模型输出：只能选择当前候选，不能扩展注册表、能力或权限。
- Plugin 在等待确认期间失效：拒绝执行，不自动切换 provider。
