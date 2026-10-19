# Proposal

## Why

当前仓库使用根级 `dist/packages/**` 构建布局，并通过各包根目录的 JavaScript 转发文件间接加载构建产物，导致包边界、源码入口和发布入口相互耦合。仓库未来需要把多个 `@iar/*` 模块作为可安装包发布，因此必须让每个包独立产出、独立声明入口，并确保消费者不依赖仓库源码、根目录路径或特殊运行时 loader。

## What Changes

- 为所有可发布包统一采用 `src/` 到包内 `dist/` 的构建布局。
- 统一使用 `package.json` 的 `exports`、`types`、`main` 和 `files` 声明发布入口与类型产物。
- 包之间只通过 `@iar/*` 公共包名引用，禁止跨包直接引用其他包的 `src` 或根级 `dist` 路径。
- Node 原生 ESM 包内部继续使用带 `.js` 的相对导入，使编译产物可被 Node 直接执行。
- 移除依赖 `../../dist/packages/...` 的包根转发入口，并将测试、Demo 和构建脚本切换到公共包入口或包内产物。
- 通过根级 TypeScript Project References 统一编排各包构建，同时保留独立包的声明文件和 source map 产出。
- 将生成的 `dist/` 作为构建产物忽略，但通过 npm `files` 配置确保发布包包含它。
- 忽略 `.agents/` 和 `.claude/` 的新增本地文件；不从 Git 索引移除现有已跟踪文件。
- 增加包级打包/安装冒烟校验，确保发布内容只暴露声明的公共入口。

## Capabilities

### New Capabilities

- `package-distribution`: 为 IAR 包提供独立构建产物、类型声明、公共导出边界和可验证的 npm 发布形态。

### Modified Capabilities

- None. 现有运行时、Provider SPI 和 SQLite 持久化行为保持不变。

## Impact

- 影响根级 TypeScript 配置、构建脚本、各 `packages/*` 和 `packages/adapters/*` 的 `package.json`、入口文件与测试/Demo 导入。
- 影响 npm 包的目录布局和公开入口，属于发布结构变更；包内运行时 API 需保持兼容。
- 不新增 Vite 到 Node 核心包构建链；未来浏览器包可独立采用 Vite。
- `.gitignore` 增加本地 AI 工具目录规则，但不影响当前已跟踪的项目配置文件。
