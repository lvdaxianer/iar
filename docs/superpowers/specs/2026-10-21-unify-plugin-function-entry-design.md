# IAR Plugin > Function 统一入口设计

## 目标

IAR 采用 `Plugin > Function > Operation` 的公共模型：Plugin 是可独立分发和管理的能力包，Function 是包内的一项业务能力，Operation 是 Function 支持的具体动作。应用通过 `@iar/agent` 统一启动，插件作者通过 `@iar/plugin` 定义和注册能力。

本次是未发布项目的破坏性切换，不保留旧的 `FunctionPluginManifest`、`PluginRegistration.handler` 和 `PluginHost({ functionIds })` API。

## 包边界

```text
@iar/contracts  公共契约、Schema、版本和稳定错误
@iar/plugin     definePlugin、defineFunction、插件作者类型
@iar/plugins    PluginHost、FunctionRegistry、生命周期和运行时索引
@iar/runtime    意图识别后的有限决策、动态路由、执行前重验证
@iar/agent      统一入口，批量装配 Plugin 包和运行时依赖
@iar/pi-bridge  Pi 适配层，不管理 IAR 会话和业务注册
```

应用侧使用：

```ts
import { createIarAgent } from '@iar/agent';
import { defineFunction, definePlugin } from '@iar/plugin';

const ticketPlugin = definePlugin({
  manifest: {
    pluginId: 'ticket-system',
    version: '1.0.0',
    description: '工单业务能力包',
    capabilities: ['ticket.read', 'ticket.write']
  },
  functions: [
    defineFunction({
      definition: {
        functionId: 'ticket.query',
        version: '1.0.0',
        name: '查询工单',
        description: '查询工单状态',
        actionTypes: ['query'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        capabilities: ['ticket.read'],
        riskLevel: 'low'
      },
      operations: [{ name: 'query', kind: 'read', description: '查询工单' }],
      handler: queryTicket
    })
  ]
});

const agent = createIarAgent({ plugins: [ticketPlugin] });
```

## 运行时模型

```text
PluginPackage
├── PluginManifest：包级身份、版本、依赖、能力、生命周期、策略
└── FunctionRegistration[]
    ├── FunctionDefinition：functionId、Schema、动作类型、风险和能力
    ├── Operation[]：Function 下的具体操作
    └── FunctionHandler：Function 的执行实现
```

PluginHost 是 Plugin 生命周期的唯一权威；FunctionRegistry 只从 Host 当前记录派生 `functionId -> providers` 索引，不拥有第二份授权状态。一个 Plugin 可以提供多个 Function，多个 Plugin 也可以提供同一个 Function 的不同实现。

## 路由和会话不变

数据层级改为 Plugin-first，但路由协议保持 Function-first：

```text
用户输入
  → IAR SessionManager
  → 意图识别
  → Function 规则和决策
  → 选中 Function 后筛选 Plugin 实现
  → Host 状态/租户/权限/能力/策略重验证
  → Operation 和确认门禁
  → FunctionHandler
```

因此本次不重新设计 Intent Model、JEV、BehaviorContext、确认状态、Workflow 或 Pi Bridge。短追问继续复用当前会话的 routing scope，动态候选仍然是有限集合，模型不能添加 Function、Plugin、能力或权限。

IAR 是唯一会话状态源。Pi 通过 `@iar/pi-bridge` 把输入转给 IAR，Pi 不注册 IAR Function，也不创建第二套会话状态。

## 校验和失败边界

- Plugin 包和其中全部 Function 先全量校验，再原子安装。
- 重复 Plugin ID、重复 Function ID、未知动作类型、无效 JSON Schema、能力越界和无 Handler 均稳定失败。
- 任一 Plugin 启用或依赖失败时，不暴露该包的任何 Function 候选。
- 卸载 Plugin 时一次性移除其全部 Function 索引，历史生命周期事件保留。
- System Plugin 只能通过显式生命周期或订阅使用，不进入业务 Function/Plugin 候选。

## 验证标准

1. contracts、Host、FunctionRegistry 和统一入口均有先失败后通过的测试。
2. 既有意图识别、Function-first 两阶段路由、动态澄清、策略确认、会话恢复和 Pi Bridge 测试继续通过。
3. `@iar/plugin` 与 `@iar/agent` 能从安装后的包根导入并解析 `.d.ts`，内部路径被拒绝。
4. sandbox、示例、脚本和 `docs` 全部使用新注册模型，仓库中不存在旧注册 API 引用。
5. `npm run lint`、`npm run build`、`npm test`、`npm run verify:packages`、OpenSpec strict validation 全部通过。
