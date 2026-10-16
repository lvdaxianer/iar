# Design

## Context

项目已经有完整的中文架构文档 `docs/README.md`，并已完成 Phase 1～5 MVP 实现。根目录需要一个面向首次阅读者的轻量入口，避免复制整篇架构文档，同时保证命令和状态信息与仓库实际内容一致。

## Goals / Non-Goals

**Goals:**

- 用一页入口文档说明项目定位、状态、核心能力和快速开始路径。
- 提供可直接执行的 npm 命令，并链接到深度文档和最终审计。
- 让 README 在源码目录变化后仍保持稳定，使用能力分组而非罗列全部文件。

**Non-Goals:**

- 不重新编写 `docs/README.md` 的完整架构设计。
- 不新增运行时行为、依赖、API 或测试逻辑。

## Decisions

- **根目录 README 采用中英混合的技术术语**：项目已有中文架构文档，用户沟通和说明使用中文；包名、命令和协议名称保留代码中的英文形式。
- **快速开始只引用现有 package scripts**：使用 `npm install`、`npm run build`、`npm test` 和 `npm run demo:fake-plugin`，避免在文档中维护重复的底层命令。
- **详细内容通过相对链接下沉**：架构边界链接到 `docs/README.md`，完成证据链接到最终审计，OpenSpec 归档链接到归档目录，根 README 只承担导航职责。

## Risks / Trade-offs

- [命令或状态未来变化] → README 明确标注当前 MVP 状态，并在每次发布或重大变更时同步更新；本次使用仓库现有脚本和最终审计作为事实来源。
- [README 与详细文档内容重复] → 根 README 只保留摘要和入口，完整设计继续由 `docs/README.md` 维护。
