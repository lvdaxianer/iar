# Tasks

## 1. 建立包级构建基线

- [x] 1.1 创建共享 TypeScript 构建基线和每包 `tsconfig.build.json`，将 `rootDir` 固定为包内 `src`、`outDir` 固定为包内 `dist`，启用声明文件、source map、NodeNext ESM，并用 `tsc -b` Project References 表达包依赖；验证 `tsc -b --dry` 能列出稳定的依赖构建顺序。
- [x] 1.2 更新根 `package.json` 的 build、typecheck 和 clean 脚本，使干净工作树可以从零生成所有包内 `dist`；验证删除构建产物后执行 `npm run build` 成功且每个包生成 `dist/index.js` 和 `dist/index.d.ts`。
- [x] 1.3 为根构建增加无产物类型检查入口，确保 `npm run lint` 不依赖旧的根级 `dist`；验证在删除 `dist` 后执行类型检查仍能得到完整、非静默的诊断。

## 2. 迁移基础包的发布边界

- [x] 2.1 迁移 `packages/contracts`、`packages/abi`、`packages/plugin-sdk`、`packages/persistence-spi` 和 `packages/subscriptions` 的包级构建配置与 `package.json`，统一 `main`、`types`、`exports`、`files` 到包内 `dist`；验证这些包从自身包名导入成功且未声明路径被拒绝。
- [x] 2.2 删除基础包依赖根级 `../../dist/packages/...` 的 JavaScript 转发入口，并保留 `src/index.ts` 作为唯一源码入口；验证构建后每个包的公共入口只落在自身 `dist/index.js`。
- [x] 2.3 为基础包增加或调整公共入口测试，覆盖运行时导出和类型导出；验证 `npm run build`、定向测试以及 `npm pack --dry-run` 均通过。

## 3. 迁移核心运行时包

- [x] 3.1 迁移 `packages/decision`、`packages/rule-engine`、`packages/plugin-host`、`packages/runtime`、`packages/workflow` 和 `packages/control-plane` 到包内 `dist`，将跨包源码引用统一改为 `@iar/*`，将同包引用保持为 Node ESM 可解析的 `.js` 说明符；验证源码中不存在跨包 `/src/` 或 `../../dist` 引用。
- [x] 3.2 迁移 `packages/storage`、`packages/persistence-runtime`、`packages/persistence-sqlite`，保持现有 Storage 接口、Persistence SPI、Worker 和动态 Provider 行为不变；验证 SQLite Worker 的构建产物路径与 `new URL('./worker.js', import.meta.url)` 对应文件一致。
- [x] 3.3 迁移 `packages/observability`、`packages/built-in-plugins` 和 `packages/plugin-distribution`，为实际公共子路径补充显式 `exports`，不暴露 `src`；验证运行时测试通过并能从打包内容解析声明文件。
- [x] 3.4 为核心包运行现有测试与恢复/Provider 场景，覆盖包入口导入、SQLite Worker、动态 Provider 加载和类型检查；验证失败时能定位到具体包而不是被空测试集合掩盖。

## 4. 迁移适配器包与 CLI

- [x] 4.1 迁移 `packages/adapters/executors`、`packages/adapters/fastify`、`packages/adapters/postgres`、`packages/adapters/service`、`packages/adapters/sidecar` 和 `packages/adapters/temporal` 到包内 `dist`，保留 `fastify/http-boundary` 等已存在的公共子路径；验证所有 `exports` 目标在构建后存在。
- [x] 4.2 迁移 `packages/cli`，确保 CLI 的 Node 入口、声明文件和可执行脚本不依赖仓库根级 `dist`；验证从打包目录安装后执行 CLI 帮助/版本入口成功。
- [x] 4.3 运行适配器和 CLI 的定向测试、类型检查和构建；验证所有 Node 内置模块、Fastify、Postgres 类型和 Temporal 运行时依赖保持外部依赖而非被错误内联。

## 5. 更新仓库测试、Demo 与内部引用

- [x] 5.1 更新 `scripts/run-tests.mjs`、`scripts/run-fake-plugin-demo.mjs` 和 `scripts/run-agent-sandbox.mjs`，改用包公共入口或明确的包内构建产物，移除根级 `dist/packages` 假设；验证全量测试和两个 Demo 都能在干净构建后运行。
- [x] 5.2 扫描仓库源码、测试、示例和配置，清除跨包直接引用 `src`、`../../dist` 和未声明深层入口；验证 `rg` 只留下允许的包内 `.js` 相对导入和 `@iar/*` 跨包导入。
- [x] 5.3 为至少一个代表包执行临时打包消费测试：构建、`npm pack`、复制到临时目录、仅安装/导入 tarball；验证消费者不需要仓库源码、根级 `dist` 或 TypeScript/Vite loader。

## 6. 完成基线与发布卫生

- [x] 6.1 在 `.gitignore` 的托管块中加入 `.agents/` 和 `.claude/`，保留现有已跟踪文件，不执行 `git rm --cached`；验证已跟踪文件仍由 `git ls-files` 返回，新增探测文件被 `git check-ignore` 命中。
- [x] 6.2 统一所有包的 `files`、`exports`、`types` 和 `main` 字段，并检查 `dist/` 被 Git 忽略但被 npm tarball 包含；验证每个包的 `npm pack --dry-run` 清单只含预期发布文件。
- [x] 6.3 创建发布验证脚本，逐包检查 `exports` 和 `types` 指向的文件存在、公共入口可导入、未声明内部路径不可导入；验证脚本在缺少任意产物时以非零状态失败。

## 7. 全量集成验证

- [x] 7.1 在干净任务 worktree 中执行 `npm run build`、`npm run lint`、`npm test`、包发布冒烟检查和 OpenSpec 严格校验；记录每条命令的通过结果和已知环境前提。
- [x] 7.2 执行代码审查和计划一致性审计，确认每个 `package.json`、入口、构建配置、测试和文档变更都对应 `package-distribution` 规范；修复审计发现的问题后再次运行全量验证。

## Workflow follow-up

- 按项目要求逐任务提交，并在每个任务的实现、测试、审查和审计通过后立即标记对应复选框。
- 完成全部任务后归档 `standardize-package-build-layout`，再将任务分支合并回 `master`；集成前必须保留原工作区已有的用户修改和冲突状态，不得覆盖或清理。
