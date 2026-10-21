# Design

## Context

本变更基于 `@iar/runtime` 和 `@iar/pi-bridge` 已有的 TypeScript project references、原生 ESM 入口和 `dist` 发布边界。现有构建已经生成 `.js`、`.d.ts` 和 source map，但根脚本没有面向两个目标包的定向打包命令，发布校验也没有完整验证 Pi Extension 子路径及 Pi 元数据。

## Goals / Non-Goals

**Goals:**

- 让 Runtime 和 Pi Bridge 各自生成可独立安装的 npm tarball。
- 让 Node.js、TypeScript 和 Pi 宿主都从声明的包入口加载构建产物。
- 在发布前自动发现缺失的 JavaScript、`.d.ts`、Pi Extension 元数据和越界文件。
- 保持当前库构建可调试，不引入 minify、bundle 或运行时依赖扩张。

**Non-Goals:**

- 不把 HTTP Server、模型 Provider 或端口监听逻辑移入 `@iar/runtime`。
- 不把模型配置、`.env`、数据库配置或部署脚本发布到 npm 包。
- 不改变 Pi Bridge HTTP 协议、Runtime 决策语义或会话状态实现。
- 不把当前所有 workspace 包都标记为公开发布包。

## Decisions

### 1. 使用现有 `dist` 作为唯一发布目录

继续使用各包 `tsconfig.build.json` 的 `rootDir: src` 和 `outDir: dist`。声明文件与对应 JavaScript 同目录生成，包元数据通过 `main`、`types` 和 `exports` 指向 `dist`。使用 `files: ["dist"]` 限制 tarball 内容。

备选方案是建立独立 `types/` 目录或使用单文件 bundler；前者增加类型路径维护成本，后者会削弱当前包的 ESM、调试和可替换边界，因此不采用。

### 2. 只为 Runtime 和 Pi Bridge 增加公开发布元数据

两个包增加 scoped npm 的 `publishConfig.access = public`。`@iar/runtime` 保持无 Pi、HTTP 和具体模型依赖；`@iar/pi-bridge` 保持无 Runtime 依赖，并通过 `exports["./pi-extension"]` 和 `pi.extensions` 暴露 Pi 入口。

`@iar/cli` 继续作为仓库内启动器边界，不在本变更中把它变成 Runtime 的隐式依赖，也不把 HTTP 服务代码打进 Runtime。

### 3. 使用根脚本提供目标包打包入口

根 `package.json` 增加 `pack:runtime`、`pack:pi` 和 `pack:all`，统一先执行构建再调用 workspace `npm pack`。`verify:packages` 继续作为发布前的结构和 tarball 冒烟校验入口。

### 4. 发布校验同时验证通用边界和 Pi 特有边界

保留现有 15 个 workspace 包的通用构建、入口和 tarball 检查；对 Runtime 额外要求可发布，对 Pi Bridge 额外检查：

- `exports["./pi-extension"]` 的 JS 和 `.d.ts` 目标存在。
- `pi.extensions` 指向同一包内的编译入口。
- Pi Bridge 不依赖 Runtime。
- dry-run tarball 不包含 `src`、`.env`、配置目录或本地编辑器目录。

### 5. 本地编辑器状态只通过忽略规则处理

按项目托管块规则将 `.vscode/` 加入 `.gitignore`，不删除现有本地文件，也不把编辑器配置加入 npm 包。

## Risks / Trade-offs

- [Risk] npm 公开发布仍需要维护版本、变更日志和 registry 登录流程。→ 本变更只固化包元数据和本地验证，不自动执行 `npm publish`。
- [Risk] `files: ["dist"]` 依赖构建先成功。→ 所有定向打包脚本先执行 `npm run build`，发布校验继续检查入口文件和 tarball。
- [Risk] source map 会增加 tarball 体积。→ 保留 source map 以支持库消费者调试；如果后续需要减小体积，单独评估 source map 发布策略。
- [Risk] `@iar/cli` 仍不是本次两个目标包的一部分。→ 文档明确区分库发布物和服务启动器，后续可单独为 CLI 设计发布变更。

## Migration Plan

1. 更新包 manifest、根打包脚本、发布校验和 `.gitignore`。
2. 执行构建、包验证和定向 `npm pack --dry-run`。
3. 消费者使用 `@iar/runtime` 或 `@iar/pi-bridge` 的 tarball/npm 版本；模型和端口配置继续由部署环境提供。
4. 若验证失败，不发布 tarball；回滚本次 manifest、脚本和校验变更即可，不涉及数据库或运行时数据迁移。
