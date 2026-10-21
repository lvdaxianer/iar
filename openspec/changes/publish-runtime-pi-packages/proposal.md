# Proposal

## Why

当前 `@iar/runtime` 和 `@iar/pi-bridge` 已经具备独立编译入口，但发布配置、定向打包命令和 Pi 子入口校验还不够明确。现在补齐发布边界，可以让 Runtime 和 Pi 适配器分别生成可安装的 npm tarball，同时保证 TypeScript 声明、ESM 入口和 Pi Extension 元数据不会在发布时丢失。

## What Changes

- 将 `@iar/runtime` 和 `@iar/pi-bridge` 明确标记为可发布的 scoped npm 包。
- 为两个目标包补充定向 `npm pack` 命令和统一发布校验命令。
- 扩展发布校验，检查 Pi Extension 子路径、`pi.extensions` 元数据、公共入口和类型声明。
- 保持库代码由 TypeScript 直接编译，不引入 minify 或 bundle；发布物只包含 `dist` 和 `package.json`。
- 保持模型配置、端口配置和运行时 secrets 在部署环境中注入，不打入 npm tarball。
- 忽略本地 `.vscode/` 配置，避免编辑器状态进入提交。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `package-distribution`: 扩展发布边界，使 `@iar/pi-bridge` 与 `@iar/runtime` 都能被定向打包，并验证 Pi 子入口和扩展元数据。

## Impact

- 修改根目录 `package.json` 的发布脚本。
- 修改 `packages/runtime/package.json` 与 `packages/adapters/pi/package.json` 的发布元数据。
- 修改 `scripts/verify-package-distribution.mjs` 的发布冒烟校验。
- 同步 `openspec/specs/package-distribution/spec.md` 与发布说明文档。
- 修改项目 `.gitignore`，忽略本地 `.vscode/`。
- 不改变 Runtime 的决策、插件执行、HTTP 协议或模型 Provider 行为。
