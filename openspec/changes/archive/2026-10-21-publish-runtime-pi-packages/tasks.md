# Tasks

## 1. 发布包元数据与定向打包入口

- [x] 1.1 为 `@iar/runtime` 和 `@iar/pi-bridge` 增加公开 scoped npm 发布元数据，保持 `dist`、`main`、`types` 和 `exports` 边界；通过构建后检查两个 manifest 和 `npm pack --dry-run` 结果验证。
- [x] 1.2 为根项目增加 Runtime、Pi Bridge、全 workspace 打包脚本，并将本地 `.vscode/` 加入项目忽略规则；通过脚本帮助/执行和 Git 状态检查验证不会把本地编辑器目录纳入发布物。
- [x] 1.3 更新发布说明，明确 `.js`、`.d.ts`、source map、模型配置和端口配置的归属；通过文档中的命令与实际脚本逐项核对。

## 2. 发布边界校验与回归验证

- [x] 2.1 扩展发布校验器，检查 Runtime/Pi Bridge 的可发布性、Pi Extension 子路径、`pi.extensions` 元数据和 tarball 文件白名单；先用当前实现运行校验确认新增断言能捕获缺失配置，再完成实现。
- [x] 2.2 运行构建、发布校验、目标包 dry-run 打包和相关测试，确认所有 `.d.ts` 与公共入口存在、源码和部署配置未进入 tarball；记录命令结果并修复发现的问题。

## Workflow follow-up

- 完成每个任务的代码评审、专项审计和验证后，将任务分支合并回 `master`。
- 所有任务完成后执行 OpenSpec verify、最终审计并归档本变更。
