# Proposal

## Why

项目当前只有 `docs/README.md`，新成员或用户从仓库根目录进入时无法快速了解项目定位、当前实现范围、启动方式和验证命令。现在 Phase 1～5 MVP 已完成，需要补充一个根目录入口文档。

## What Changes

- 新增根目录 `README.md`，作为项目入口文档。
- 说明 IAR 的定位、当前完成状态、核心能力和主要目录。
- 提供安装、构建、测试和 fake plugin demo 命令。
- 链接到完整架构说明、最终实现审计和 OpenSpec 归档。

## Capabilities

### New Capabilities

本变更仅补充项目文档，不引入新的系统能力。

### Modified Capabilities

无。`.openspec.yaml` 使用 `skip_specs: true`，因为本变更不修改运行时行为或契约要求。

## Impact

- 仅影响仓库根目录文档和本次变更的 OpenSpec 追踪文件。
- 不修改 TypeScript 源码、测试、依赖、API 或运行时配置。
