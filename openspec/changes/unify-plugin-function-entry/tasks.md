# Tasks

## 1. 契约模型迁移

- [ ] 1.1 新增失败测试，锁定 `PluginManifest` 只包含包级字段、`PluginPackage` 能包含多个 Function、系统 Plugin 不含业务 Function；验证测试因新 API 尚未实现而失败。
- [ ] 1.2 重构 `@iar/contracts` 的 Plugin/Function 类型、TypeBox Schema、关系校验、ABI 类型和导出，移除旧 `FunctionPluginManifest` 字段；验证 contracts build 与契约测试通过。
- [ ] 1.3 增加 Plugin 包级原子校验测试，覆盖重复 Function、未知 actionType、无效 JSON Schema、能力越界和空业务包；验证失败不产生运行时状态。

## 2. Plugin SDK、Host 与 Function 索引

- [ ] 2.1 新增失败测试，锁定 `defineFunction`、`definePlugin`、`PluginPackage` 和 `FunctionHandler` 的注册形状；验证测试先按预期失败。
- [ ] 2.2 实现 `@iar/plugins` 的 Function 注册类型和 `@iar/plugin` SDK 构建器，确保定义结果不可变且不复制 Handler 授权；验证 SDK 单元测试与类型检查通过。
- [ ] 2.3 新增失败测试，覆盖一个 Plugin 多 Function、多个 Plugin 提供同一 Function、批量安装原子性、生命周期卸载和系统 Plugin 隔离；验证测试先按预期失败。
- [ ] 2.4 重构 `PluginHost`、安装流程、生命周期事件、候选描述和 `FunctionRegistry`，让 Function ID 从 Plugin 包派生并在生命周期变化时更新；验证 Host 测试、插件分发测试和路由候选测试通过。

## 3. 运行时路由行为保持

- [ ] 3.1 新增回归测试，证明意图识别输入、Function-first 两阶段决策、低置信澄清、Plugin 最终重验证、策略/确认和会话 routing scope 与迁移前语义一致；验证测试覆盖成功、拒绝和澄清路径。
- [ ] 3.2 修改 `@iar/runtime`、Fastify 边界和执行适配器，从嵌套 Function 读取 Handler、operations、Schema 和 actionTypes；验证既有 runtime/integration 测试与新增回归测试通过。
- [ ] 3.3 验证 Pi Bridge 只依赖 IAR 会话入口且未修改 Pi 仓库；运行 Pi bridge 测试并检查 `pi` 工作区状态保持干净。

## 4. 统一入口包

- [ ] 4.1 新增 `packages/plugin` 和 `packages/agent` 的 package、TypeScript project reference、exports 和构建入口；验证干净构建生成各包 JS、d.ts 和 source map。
- [ ] 4.2 实现 `createIarAgent` 的批量校验、原子安装、依赖启用、FunctionRegistry 装配和失败清理；验证统一入口测试覆盖完整启动与部分失败禁止使用。
- [ ] 4.3 增加包分发冒烟测试，验证 `@iar/plugin`、`@iar/agent` 安装后导入、类型解析和未声明内部路径拒绝；运行 `npm run verify:packages`。

## 5. 示例、测试和文档迁移

- [ ] 5.1 将 `examples/plugins` 和 `examples/agent-sandbox` 迁移为 Plugin 包包含多个或一个 Function 的定义方式，并让 sandbox 通过 `createIarAgent` 装配；验证 sandbox demo 和相关测试通过。
- [ ] 5.2 将所有测试夹具、控制面、服务适配器和脚本从旧 Manifest/Host API 迁移到新模型；验证仓库内不再存在旧注册 API 引用。
- [ ] 5.3 更新 `docs/defining-functions.md`、`docs/defining-plugins.md`，新增统一入口和架构文档，说明 Plugin/Function/Operation、注册流程、会话边界和 Pi 配合方式；验证文档示例与实际导出 API 一致。

## 6. 集成验证

- [ ] 6.1 运行 `npm run lint`、`npm run build`、`npm test`、`npm run verify:packages` 和 sandbox/fake-plugin demos，记录通过结果。
- [ ] 6.2 执行 OpenSpec strict validation、代码规范审查和需求逐项审计，确认没有旧模型残留、意图识别/动态路由行为变化或文档遗漏。

## Workflow follow-up

- 完成代码审查、提交符合项目规范的中文 Conventional Commit。
- 将任务分支合并回 `.source_branch` 指定的 `master`，在合并结果上重新验证。
- 归档 OpenSpec change 并验证归档后的主规格。
