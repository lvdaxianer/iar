# Design

## Context

当前仓库有多个 `packages/*` 和 `packages/adapters/*` 包，根级 TypeScript 配置把所有源码输出到 `dist/packages/**`，各包再用根目录 JavaScript 转发文件进入构建产物。包之间已经主要使用 `@iar/*` 名称，但包元数据仍混用源码类型入口、根级构建路径和不同的 `types` 位置。

这些包包含 Node 原生模块、Worker、动态 Provider 加载和不应被打包吞并的外部依赖。设计需要保留原生 ESM 模块图，同时让每个 npm 包在安装后自包含运行时代码和声明文件。

## Goals / Non-Goals

**Goals:**

- 每个可发布包从 `src/` 生成包内 `dist/`，入口统一为 `dist/index.js` 和 `dist/index.d.ts`。
- 使用 `package.json` 的 `exports` 封装公共 API，阻止消费者依赖 `src` 或未声明内部文件。
- 使用 TypeScript Project References 以依赖顺序构建所有包，并让干净检出可重现构建。
- 保留 Node 原生 ESM 语义、Worker 文件路径和动态外部 Provider 加载能力。
- 让 npm 打包内容包含 `dist`，但 Git 不跟踪生成的 `dist`。
- 保留当前已被 Git 跟踪的 `.agents/` 和 `.claude/` 文件，只忽略其中新增的本地文件。

**Non-Goals:**

- 不改变 Decision、Runtime、Persistence Provider 或 Storage 的业务行为和数据契约。
- 不把 Node 核心包整体改成 Vite bundle，也不引入浏览器专用构建运行时。
- 不在本次变更中把所有 `.mjs` 脚本、浏览器片段或配置文件强制改成 TypeScript。
- 不执行 `git rm --cached`，不删除任何现有源码、配置或已跟踪文件。

## Decisions

### 1. 采用包内 dist，而不是根级 dist 转发

每个包新增或采用包级构建配置，`rootDir` 为该包的 `src`，`outDir` 为该包的 `dist`。包的 `package.json` 只引用自身的 `./dist/*`。这样发布物可以独立复制、安装和验证，不需要仓库根目录的 `dist/packages` 布局或 `index.js` 转发文件。

Node 的 `exports` 目标必须是包内部、以 `./` 开头的路径，因此包内 `./dist/index.js` 比从包目录跨出到根级 `../../dist` 更符合发布边界。

### 2. 使用 tsc Project References，不使用 Vite 作为 Node 包的主构建器

根级构建使用 `tsc -b` 编排各包的构建依赖；每个包保留独立的声明文件、source map 和未打包的 ESM 文件图。这样 Worker 的 `new URL('./worker.js', import.meta.url)`、Node 内置模块和动态 `import(specifier)` 不需要被 bundler 重写。

Vite 的 alias 和 extensionless resolution 适合由 bundler 控制运行时的应用，但本仓库需要发布可直接由 Node 加载的多包模块。Vite 可作为未来浏览器包或明确需要 bundle 的入口的独立方案，不纳入 Node 核心包统一构建链。

### 3. 包间使用公共包名，包内使用 Node ESM 相对路径

跨包依赖统一使用 `@iar/<package>` 及明确声明的公共子路径，禁止访问其他包的 `src` 或 `dist`。同包内部继续使用 `./module.js`，让 TypeScript 的 NodeNext 解析在源码阶段匹配 `.ts`、在输出阶段保持可运行的 `.js` 说明符。仓库不引入 `@/` 运行时别名，因为 TypeScript `paths` 本身不会改写 Node 的运行时解析。

### 4. package.json 同时声明运行时、类型和发布文件

每个可发布包统一声明 `type: module`、`main: ./dist/index.js`、`types: ./dist/index.d.ts`、`exports` 和 `files: ["dist"]`。`exports` 只开放包根和经过审查的公共子路径；`files` 保证 npm tarball 带上构建产物，而 Git 忽略规则保证工作树不积累生成文件。

### 5. 发布验证通过打包物而不是源码工作树

构建后为每个目标包执行包内容检查和最小导入检查：确认 `exports` 指向存在的 JavaScript，`types` 指向存在的声明文件，`npm pack --dry-run` 包含这些文件，安装/临时消费包时不能依赖仓库根目录或源码目录。测试仍可在构建前执行类型检查，但公共 API 冒烟测试从包入口验证。

## Risks / Trade-offs

- [依赖构建顺序] 包的类型入口和运行时入口都来自包内 `dist`，未先构建依赖包时工作区类型解析可能失败 → 使用 Project References 和根级 `tsc -b`，并让验证脚本先执行完整构建。
- [入口收紧造成深导入破坏] `exports` 会阻止过去未声明的深层路径 → 先盘点仓库内深导入，只把实际需要的公共子路径显式加入 `exports`，并用包冒烟测试锁定入口。
- [包清单不完整] npm 发布物可能漏掉 Worker 或声明文件 → 使用 `files: ["dist"]`、构建后文件存在性检查和 `npm pack --dry-run` 验证。
- [现有工作区脏状态] 当前集成 checkout 有用户未提交修改和冲突 → 所有任务在独立 worktree 中完成；集成前只在集成分支干净且用户改动得到保留时合并。
- [旧存储与新 Provider 并存] 构建布局统一不会自动消除 `storage` 与 `persistence-*` 的功能重叠 → 本变更只统一包边界，不改变两套运行时契约，另行安排架构收敛。

## Migration Plan

1. 为包构建建立共享配置、Project References 和包级 `dist` 输出。
2. 迁移一个代表性包并用其验证入口、声明、Worker/动态导入和 npm tarball 规则。
3. 批量迁移其余 `packages/*` 与 `packages/adapters/*` 的 `package.json`、入口和构建配置。
4. 更新仓库测试、Demo 和脚本，移除 `../../dist/packages` 以及跨包 `src` 引用。
5. 增加包发布冒烟检查，运行完整类型检查、构建和测试。
6. 更新 `.gitignore`，新增 `.agents/` 和 `.claude/`；仅影响未跟踪文件，不移除已跟踪文件。
7. 若迁移中发现公共入口缺失，先补充 `exports` 和测试；若某包不能独立发布，则保留为内部包并明确 `private`，不伪装成可发布包。

## Open Questions

无。所有现有包统一采用可独立构建和打包的目录布局；是否将某个包从 `private: true` 改为公开发布属于后续版本发布决策，本次不改变该字段的现有语义。
