# 提案：统一架构技术方案并与实现对齐

## Why

当前 `docs/README.md` 同时承担架构说明、参考资料入口和历史方案索引，相关内容又分散在 `docs/references`、`docs/superpowers/plans` 和 `docs/superpowers/specs`。其中部分描述仍停留在旧的“仅结构化上下文”模型，无法准确反映当前实现已经采用的结构化上下文、有限最近消息窗口、有序事实链、动态插件描述、澄清状态和会话恢复流程。

需要建立一个明确的文档源头，并让技术方案以当前代码为准，避免方案继续携带业务硬编码或引用已经失效的目录路径。

## What Changes

- 新增 `docs/架构技术方案/`，作为架构技术方案、参考资料、设计规格和执行计划的统一归档目录。
- 将原 `docs/README.md` 迁移为 `docs/架构技术方案/README.md`，并在根 `docs/README.md` 保留简洁索引。
- 将 `docs/references`、`docs/superpowers/plans`、`docs/superpowers/specs` 迁移到新目录下，修正受影响的 Markdown 路径。
- 新增实现对齐矩阵，明确每个架构结论对应的代码入口、数据结构和当前状态。
- 修订架构方案中与当前实现不一致的上下文输入、事实追加、自然语言顺序指代、澄清兜底、持久化恢复和插件动态发现描述。
- 保留 `docs/implementation-audits` 原位置；它是实现审计资料，不属于架构方案归档内容。

## Capabilities

本变更仅调整技术文档目录、文档内容和链接，不新增或修改运行时能力、接口、数据结构或业务行为。因此本变更使用 `skip_specs: true`，不创建虚构的运行时规格增量。

## Impact

- 影响范围：`docs/` 与 `openspec/changes/architecture-docs-alignment/`。
- 不修改 `packages/`、`examples/`、配置文件或数据库结构。
- 文档中的代码路径、输入边界和状态流转以当前仓库源码为证据；示例中的插件、字段和实体均标注为动态描述或非业务核心示例。
