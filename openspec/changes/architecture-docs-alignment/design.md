# 设计：统一架构技术方案并与实现对齐

## 1. 目录设计

统一后的文档结构如下：

```text
docs/
├── README.md                         # 文档总索引
├── 架构技术方案/
│   ├── README.md                     # 当前架构方案主文档
│   ├── 实现对齐矩阵.md                # 方案结论到源码入口的映射
│   ├── references/                   # 可复用参考资料和示例
│   ├── plans/                       # 方案执行计划及历史记录
│   └── specs/                       # 架构设计规格及历史记录
└── implementation-audits/           # 独立的实现审计资料
```

`docs/架构技术方案/README.md` 是架构方案唯一主入口；`实现对齐矩阵.md` 是核对实现时的快速证据索引；`plans/` 和 `specs/` 作为历史设计追踪资料，不替代当前主方案。

## 2. 文档对齐原则

1. **代码优先**：当前源码已经实现的行为必须以源码和测试为依据；未实现内容只能标记为规划或非目标。
2. **业务无关**：核心方案只描述运行时机制、契约、状态和插件描述，不把具体业务能力、功能目录或实体字段写死在核心流程中。
3. **可信事实追加**：每个已确认事实产生独立有序记录；后续事实追加，不覆盖历史记录。可更新的是焦点指针、澄清状态和投影信息。
4. **上下文分层**：模型输入同时包含结构化行为上下文、动态能力描述和有界的最近原文消息；最近原文是不可信输入，不能直接成为执行授权。
5. **指代先候选后决策**：自然语言“上一个/前一个”等关系先转换为有界候选集；唯一候选才可继续，歧义或缺失必须进入澄清，不得静默猜测。
6. **恢复可复现**：会话恢复先恢复结构化快照，再按策略从持久化消息表读取最近消息窗口；最近消息不重复写入可信行为上下文。

## 3. 当前实现映射

主方案将按以下映射修订：

| 架构主题 | 当前实现证据 |
| --- | --- |
| 行为上下文与事实历史 | `packages/contracts/src/types-state.ts`、`packages/workflow/src/context-projector.ts` |
| 最近消息窗口与模型输入边界 | `examples/agent-sandbox/src/session-routing.ts`、`examples/agent-sandbox/src/models/model-input-transport.ts` |
| 自然语言关系候选 | `packages/runtime/src/fact-relation.ts`、`packages/decision/src/model-gateway/adapters.ts` |
| 歧义、未解析和澄清状态 | `examples/agent-sandbox/src/session.ts`、`examples/agent-sandbox/src/session-stream-turn.ts`、`packages/workflow/src/event-log.ts` |
| 动态插件描述 | `examples/agent-sandbox/src/plugin-host.ts` 及其调用方 |
| SQLite 会话恢复 | `examples/agent-sandbox/src/session-core.ts`、`packages/persistence-spi`、`packages/persistence-sqlite` |
| 压缩与可信边界 | `examples/agent-sandbox/src/models/model-input-transport.ts`、`packages/workflow/src/context-compactor.ts` |

## 4. 链接迁移规则

- 原 `docs/README.md` 内指向 `config/` 和 `.env.example` 的链接，迁移后分别改为 `../../config/` 和 `../../.env.example`。
- 原 `docs/references/` 下的仓库根目录相对链接，迁移后增加一层 `../`。
- 文档中出现的旧目录文字路径统一替换为 `docs/架构技术方案/...`。
- 根 `docs/README.md` 只保留导航，不复制架构正文，避免两个主文档再次漂移。

## 5. 验收边界

验收只检查文档变更：目录结构、链接可解析性、关键实现描述与源码一致性、Git diff 中没有代码文件变更。运行时行为和测试结果不因本变更改变。
