# Plugin > Function 统一入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 IAR 的公共注册模型切换为 `Plugin > Function > Operation`，提供 `@iar/plugin` SDK 和 `@iar/agent` 统一入口，同时保持意图识别、Function-first 两阶段动态路由、会话和 Pi Bridge 行为不变。

**Architecture:** `@iar/contracts` 定义包级 Plugin Manifest 和 FunctionDefinition；`@iar/plugin` 构造不可变 PluginPackage；`@iar/plugins` 负责 PluginHost 生命周期及从包派生的 FunctionRegistry；`@iar/agent` 原子装配 Host、Registry 和 runtime 依赖。路由仍先选择 Function，再从该 Function 的 Plugin providers 中选择实现。

**Tech Stack:** Node.js 24、TypeScript 7、NodeNext ESM、TypeBox、Ajv、npm workspaces、Node test runner。

---

### Task 1: 先建立新契约的失败测试

**Files:**
- Create: `tests/contract/plugin-package-contract.test.ts`
- Create: `tests/contract/unified-agent-entry.test.ts`
- Test command: `node --test dist/tests/contract/plugin-package-contract.test.js dist/tests/contract/unified-agent-entry.test.js`

- [ ] **Step 1: 写出 Plugin > Function 注册失败测试**

测试必须验证以下公共形状尚不存在时失败：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineFunction, definePlugin } from '@iar/plugin';

test('one Plugin can own multiple independently routable Functions', () => {
  const plugin = definePlugin({
    manifest: { pluginId: 'ticket-system', version: '1.0.0', description: '工单', capabilities: ['ticket.read'] },
    functions: [
      defineFunction({ definition: functionDefinition('ticket.query'), operations: [], handler: handler }),
      defineFunction({ definition: functionDefinition('ticket.create'), operations: [], handler: handler })
    ]
  });
  assert.deepEqual(plugin.functions.map((item) => item.definition.functionId), ['ticket.query', 'ticket.create']);
});
```

同时添加：空 Function、重复 Function ID、未知 `actionTypes` 和无效嵌入 Schema 的失败断言。测试 fixture 中使用真实 JSON Schema 和 `FunctionHandler`，不 mock Host。

- [ ] **Step 2: 运行失败测试**

运行 `npm run build && node --test dist/tests/contract/plugin-package-contract.test.js`。

预期：因 `@iar/plugin` 尚未存在或新类型尚未导出而失败；若测试通过，说明测试没有锁定新行为，先修正测试。

- [ ] **Step 3: 提交测试红灯快照**

```bash
git add tests/contract/plugin-package-contract.test.ts tests/contract/unified-agent-entry.test.ts
git commit -m "✅ test(插件): 添加统一注册契约红灯测试\n\n锁定 Plugin 包包含多个 Function、原子校验和统一入口行为。\n\nRefs: OpenSpec unify-plugin-function-entry task 1.1"
```

### Task 2: 重构 contracts 和 Plugin SDK

**Files:**
- Modify: `packages/contracts/src/types-base.ts`
- Modify: `packages/contracts/src/schema-primitives.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/validation.ts`
- Modify: `packages/contracts/src/abi/types.ts`
- Modify: `packages/plugins/src/sdk/index.ts`
- Create: `packages/plugin/package.json`
- Create: `packages/plugin/tsconfig.build.json`
- Create: `packages/plugin/src/index.ts`
- Test: `tests/contract/plugin-package-contract.test.ts`

- [ ] **Step 1: 将 Manifest 改为包级字段**

把业务 Manifest 的公共字段改成包级元数据，业务分支使用 `pluginKind: 'business'`、`scope: 'plugin'`；删除 `functionId`、`actionTypes`、`operations`、`inputSchema`、`outputSchema`。`FunctionDefinition` 保留这些 Function 级字段。系统分支继续使用 `pluginKind: 'system'`、`scope: 'runtime'`。

在 `types-base.ts` 中定义：

```ts
export type FunctionRegistration = {
  definition: FunctionDefinition;
  operations: readonly PluginOperation[];
  handler: FunctionHandler;
};

export type PluginPackage = {
  manifest: PluginManifest;
  functions: readonly FunctionRegistration[];
};
```

为避免 contracts 依赖运行时 Handler，`FunctionRegistration` 和 `PluginPackage` 放到 `@iar/plugins` SDK 类型中；contracts 只保留可序列化的 `FunctionDefinition`、`PluginManifest` 和系统/包级 Schema。

- [ ] **Step 2: 更新 TypeBox Schema 和验证关系**

`FunctionPluginManifestSchema` 改名为 `BusinessPluginManifestSchema`，`PluginManifestSchema` 的业务分支不再接受旧字段；`validatePluginManifestRelations` 只校验包级 capability/policy。新增 `validateFunctionDefinition`，并在 SDK 的 `validatePluginPackage` 中逐项校验 Function definition、operations、Handler 和 Function 能力必须属于 Plugin capability 集合。

- [ ] **Step 3: 实现 `@iar/plugin` 构造器**

实现：

```ts
export function defineFunction(input: FunctionRegistrationInput): FunctionRegistration;
export function definePlugin(input: PluginPackageInput): PluginPackage;
```

两个函数都复制数组和普通对象边界，冻结返回的注册目录，不冻结 Handler；不执行 Handler。返回对象只暴露新模型，不导出任何旧 API 别名。

- [ ] **Step 4: 运行 contracts/SDK 测试变绿**

运行：

```bash
npm run build
node --test dist/tests/contract/plugin-package-contract.test.js
npm run lint
```

预期：Task 1 的 Plugin 包、Function 校验和旧字段拒绝测试通过。

- [ ] **Step 5: 提交契约和 SDK**

```bash
git add packages/contracts packages/plugins/src/sdk packages/plugin tests/contract/plugin-package-contract.test.ts
git commit -m "✨ feat(插件): 建立 Plugin 包和 Function 注册契约\n\n将业务插件 Manifest 改为包级边界，并新增 Function 注册 SDK。\n\nBREAKING CHANGE: 移除单 Function Plugin Manifest\nRefs: OpenSpec unify-plugin-function-entry task 1.2"
```

### Task 3: 重构 PluginHost 和 FunctionRegistry

**Files:**
- Modify: `packages/plugins/src/host/types.ts`
- Modify: `packages/plugins/src/host/plugin-installation.ts`
- Modify: `packages/plugins/src/host/plugin-host.ts`
- Modify: `packages/plugins/src/host/plugin-events.ts`
- Create: `packages/plugins/src/host/function-registry.ts`
- Modify: `packages/plugins/src/host/index.ts`
- Test: `tests/contract/plugin-installation.test.ts`
- Test: `tests/contract/plugin-lifecycle.test.ts`
- Test: `tests/routing/scoped-plugin-routing.test.ts`

- [ ] **Step 1: 写 Host 红灯测试**

用 `PluginPackage` fixture 验证：`new PluginHost()` 不再接受 `functionIds`；一个包安装两个 Function；两个包可提供相同 Function；任一 Function 校验失败时整个包无记录；卸载包后所有 Function provider 消失；system package 不进入 registry。

- [ ] **Step 2: 实现嵌套记录**

将 `PluginRecord` 改为 `{ manifest, functions, state }`，其中 `functions` 是按 Function ID 索引的只读记录。`PluginHost.install/installAll` 先校验完整 package，再排序依赖，最后原子写入 Plugin record 和 Function provider。删除 `PluginHostOptions.functionIds`。

- [ ] **Step 3: 实现 FunctionRegistry**

新增 `FunctionRegistry`，提供：

```ts
list(): readonly FunctionDefinition[];
providers(functionId: string): readonly PluginFunctionRecord[];
get(functionId: string): FunctionDefinition | undefined;
```

Registry 只接受 Host 的当前记录快照和生命周期更新，不能单独注册 Function，也不能授予权限。

- [ ] **Step 4: 迁移候选描述和最终重验证**

`PluginHost.candidates(functionId)` 从嵌套 Function 记录返回当前 enabled providers；`resolveCandidate(functionId, pluginId)` 必须确认 package enabled、Function 存在、Handler 存在并返回 Function-specific metadata。生命周期事件中的 `functionId` 从 nested registration 生成，system package 不生成业务 Function 事件。

- [ ] **Step 5: 运行 Host 测试并提交**

运行 `npm run build && node --test dist/tests/contract/plugin-installation.test.js dist/tests/contract/plugin-lifecycle.test.js dist/tests/routing/scoped-plugin-routing.test.js`，预期全部通过。

```bash
git add packages/plugins tests/contract tests/routing/scoped-plugin-routing.test.ts
git commit -m "✨ feat(插件): 从插件包派生 Function 索引\n\n让 Host 管理包级生命周期并原子暴露嵌套 Function providers。\n\nBREAKING CHANGE: PluginHost 不再接收 functionIds\nRefs: OpenSpec unify-plugin-function-entry task 2.4"
```

### Task 4: 保持 Runtime 路由和执行语义

**Files:**
- Modify: `packages/runtime/src/routing.ts`
- Modify: `packages/adapters/fastify/src/http-boundary.ts`
- Modify: `examples/agent-sandbox/src/session-routing.ts`
- Create: `tests/routing/plugin-package-routing-regression.test.ts`

- [ ] **Step 1: 写路由回归测试**

覆盖同一输入经过新包模型后仍然：Function decision 先于 Plugin decision；低分返回 clarification；错误 Function/Plugin 不执行；选中的 Handler 收到真实 `functionId` 和 `pluginId`；会话 routing scope 和 operation confirmation 行为保持原值。

- [ ] **Step 2: 迁移 Runtime candidate projection**

`routing.ts` 的 Function candidates 改从 `FunctionRegistry.list()` 或 Host 派生描述读取；Plugin candidates 仍使用已选 Function 的 Host provider；`createAction`、`buildActionInput` 和 output schema 改从 `resolved.function` 读取。不得改变 `DecisionResult`、route result、reasonCode 或最终 policy gate。

- [ ] **Step 3: 迁移 Fastify 和 sandbox 执行读取**

所有 `record.manifest.functionId/actionTypes/operations/inputSchema/outputSchema` 改为 `record.functions.get(functionId)` 的 Function 记录。所有失败路径继续返回稳定错误，不把 Handler、输入或模型原文写入公开结果。

- [ ] **Step 4: 运行路由和集成测试**

运行：

```bash
npm run build
node --test dist/tests/routing/plugin-package-routing-regression.test.js
node --test dist/tests/routing/two-stage-router.test.js dist/tests/integration/model-gateway/structured-context.test.js
```

预期：决策顺序、候选边界、session scope 和 action confirmation 回归测试全部通过。

### Task 5: 新增 `@iar/agent` 统一入口

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.build.json`
- Create: `packages/agent/src/index.ts`
- Create: `tests/contract/unified-agent-entry.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.build.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.tests.build.json`

- [ ] **Step 1: 写统一入口红灯测试**

验证：

```ts
const agent = createIarAgent({ plugins: [ticketPlugin] });
assert.deepEqual(agent.functionRegistry.list().map((item) => item.functionId), ['ticket.query']);
assert.throws(() => createIarAgent({ plugins: [invalidPlugin] }), /plugin.*validation/i);
```

失败时不能返回半初始化的 Agent。

- [ ] **Step 2: 创建 `createIarAgent`**

实现 `createIarAgent({ plugins })`：校验数组、调用 `PluginHost.installAll`、按依赖启用、构建 `FunctionRegistry` 并返回 `{ pluginHost, functionRegistry }`。任一步失败都丢弃本次 Host，不执行任何 Handler。所有新增方法按项目 TypeScript 注释规范补充中文文档注释。

- [ ] **Step 3: 接入 workspace build 和 exports**

将 `@iar/agent` project reference 加入 `tsconfig.build.json`，路径映射加入 `tsconfig.json` 与 tests build；package `exports` 只声明 `.`，`files` 只包含 `dist`，生产包设置为可发布。

- [ ] **Step 4: 运行统一入口和分发测试**

运行 `npm run build && node --test dist/tests/contract/unified-agent-entry.test.js && npm run verify:packages`，预期入口导入、类型声明和内部路径边界通过。

### Task 6: 迁移 examples、fixtures、脚本和全部测试

**Files:**
- Modify: `examples/plugins/**/*.ts`
- Modify: `examples/agent-sandbox/src/functions/**/*.ts`
- Modify: `examples/agent-sandbox/src/functions/index.ts`
- Modify: `examples/agent-sandbox/src/session-dependencies.ts`
- Modify: `examples/agent-sandbox/src/execution/plugin-registry.ts`
- Modify: `scripts/run-fake-plugin-demo.mjs`
- Modify: `tests/**/*.ts`
- Modify: `tests/contract/fixtures/valid-plugin-manifest.json`

- [ ] **Step 1: 将每个示例迁移为 PluginPackage**

把每个现有单 Function manifest 拆为 Plugin-level `manifest` 和 `functions: [defineFunction(...)]`；Handler 移到对应 Function registration，Function-specific `operations`、Schema、actionTypes、riskLevel 进入 `definition/operations`。多能力示例至少保留一个 Plugin 包含两个 Function 的验证。

- [ ] **Step 2: 迁移 sandbox 启动**

删除 `sandboxFunctionIds` 作为 Host 配置边界，改为 `createIarAgent({ plugins: allSandboxPlugins })` 或从 Agent 返回 Host/Registry；catalog 只作为展示/语义描述来源，不再与 Host 维护两份 Function 所有权。

- [ ] **Step 3: 批量迁移测试 fixture**

用 `definePlugin`/`defineFunction` 替换所有 `FunctionPluginManifest`、`PluginRegistration.handler` 和 `new PluginHost({ functionIds })`；所有 `manifest.functionId` 读取改为 selected Function record。运行 `rg` 确认旧 API 只在 OpenSpec/归档历史中出现，不在源码、示例、测试或 docs 中出现。

- [ ] **Step 4: 运行 examples 和全部测试**

运行 `npm run demo:fake-plugin`、`npm run demo:sandbox` 和 `npm test`，预期示例和全量测试通过。

### Task 7: 文档、审查和最终验证

**Files:**
- Modify: `docs/defining-functions.md`
- Modify: `docs/defining-plugins.md`
- Create: `docs/plugin-function-architecture.md`
- Create: `docs/unified-entry.md`
- Modify: `openspec/changes/unify-plugin-function-entry/tasks.md`

- [ ] **Step 1: 更新 Function 文档**

说明 Function 是 Plugin 包内的能力单元，包含 definition、operations 和 handler；保留“路由 Function-first”的解释，给出 `defineFunction` 示例和候选/会话边界。

- [ ] **Step 2: 更新 Plugin 文档**

说明 Plugin 是顶层生命周期和分发单元，删除旧单 Function Manifest 示例，给出一个 Plugin 包含多个 Function、多个 Plugin 提供同一 Function、系统 Plugin 隔离和注册流程。

- [ ] **Step 3: 新增架构和统一入口文档**

记录包依赖、注册时序、意图识别/动态路由不变、IAR/ Pi 会话边界、发布包导入方式和错误边界；文档代码示例必须能对应真实导出 API。

- [ ] **Step 4: 运行最终验证**

```bash
npm run lint
npm run build
npm test
npm run verify:packages
npm run demo:fake-plugin
npm run demo:sandbox
openspec validate unify-plugin-function-entry --type change --strict
rg -n "FunctionPluginManifest|PluginRegistration|functionIds|manifest\\.functionId" packages examples tests docs scripts
```

预期 TypeScript、测试、分发检查、两个 demo 和 OpenSpec 全部退出码为 0，最后一次 `rg` 不匹配旧公共 API。

- [ ] **Step 5: 提交、合并和归档**

完成 code-review-spec、verification-before-completion 和需求逐项审计后，提交中文 Conventional Commit；在 `master` 上合并任务分支并重新跑 `npm test`，然后归档 OpenSpec change。
