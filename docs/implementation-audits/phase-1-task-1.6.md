# Phase 1 Task 1.6 实现审计

## 任务边界

- 模块：`packages/contracts/src/schema-compaction.ts`、`packages/runtime/src/compaction*.ts`。
- 目标：实现上下文压缩候选结果的模型协议、事件引用、状态规范化、工作流/确认状态保护和关键哈希校验。
- 必须覆盖：模型最小返回结构、Runtime 补齐压缩边界与 token 元数据、专用成功/失败事件载荷 Schema、引用来源校验、事件时间/ID/边界顺序、必保留事实、失败时保留旧视图。
- 排除：本任务只生成待追加事件，不直接写入 EventLog；上层 Orchestrator 负责将成功或失败事件以 EventStore 事务追加。

## 执行与交接

- 集成分支：`master`
- Task worktree：`.codex/worktrees/chg-001-t6-compaction/iar`
- Module agent：只读 `compaction-contract-review`，负责核对 README §7、Prompt、behavior-state spec、contracts 和 runtime；未修改代码。
- 独立 reviewer：同一 reviewer 经三轮复审，最终 APPROVED；审查期间未修改代码。
- 主线实现范围：新增上下文压缩 contracts/runtime/test/audit 文件，并同步公开 Schema 注册测试。

## TDD 证据

### RED

```text
npm install && npm test -- --run tests/replay/compaction.test.ts
tests/replay/compaction.test.ts(10,3): error TS2305:
Module '../../packages/runtime/src/index.js' has no exported member 'ContextCompactionService'.
tests/replay/compaction.test.ts(12,8): error TS2305:
... no exported member 'CompactionRequest'.
tests/replay/compaction.test.ts(13,8): error TS2305:
... no exported member 'CompactionResult'.
```

失败原因是目标压缩服务和公开类型尚未实现，不是测试语法或环境错误。

### GREEN 与回归

- focused：8/8 通过。
- full suite：59/59 通过。
- 独立 reviewer 复审：最终 APPROVED，无 Critical/Major/Minor。

## 计划-实现一致性

| OpenSpec 要求 | 实现证据 |
| --- | --- |
| `iar.compaction-result/v1` 候选 Schema | `CompactionResultSchema` 只接收 `schemaVersion/summary/state/references/preservedFacts/warnings`；事件边界、token、hash、generatorVersion 由 `CompactionRequest` Runtime 元数据补齐 |
| 完整 BehaviorContext 关键字段不被模型改变 | `normalizeCompactionState()` 只合并白名单片段；`BehaviorContextProjector.replaceIfIntegrityMatches()` 重新计算关键字段哈希 |
| subject、action、route、slots、workflow、pending、confirmation、intent、idempotencyKey 必须保留 | `REQUIRED_PRESERVED_FACTS` 集中声明并由 Runtime 校验，关键状态变化均返回失败 |
| 事件引用必须回指 EventLog | 引用来源事件必须存在、属于同一 run/correlation，并且目标可映射到可信上下文或来源事件稳定字段 |
| 压缩边界可审计且可重放 | 校验 `fromEventId/toEventId/firstKeptEntryId` 存在、输入顺序、时间单调、`firstKeptEntryId` 严格位于终点之后；输入和输出事件 ID 不冲突 |
| 成功事件载荷合法 | `CompactionEventPayloadSchema` 通过 `validateContract('event', ...)` 按 `eventName` 专用校验；状态、引用、事实和警告均深拷贝隔离 |
| 失败保留旧视图并记录失败事件 | 所有失败分支返回旧 `BehaviorContext` 深拷贝和 `context.compaction_failed`；失败事件及兜底事件均经过公共 EventEnvelope 校验 |
| 非法输入不污染运行时 | 非法 current、null 事件、重复 ID、倒序时间、冲突输出 ID、不完整 preservedFacts 均转换为稳定结构化失败 |

## 领域规则证据

- `backend-reliability-guidelines`：模型输出先 Schema 校验；失败不替换旧状态；边界、ID、引用和资源大小均有明确上限。
- `code-review-spec`：新增类型、方法和 Schema 带中文 JSDoc/作者/日期；职责拆分为压缩服务、候选校验和边界 helper；新增核心文件满足文件规模与注释比例门禁。
- `logging-boundaries`：本任务不新增生产日志；失败原因以结构化 `ContractErrorResult` 和失败事件交给后续 observability/EventStore。

## 验证命令

```text
npm test -- --run tests/replay/compaction.test.ts
npm run lint
npm run build
npm test
npx openspec validate iar-five-phase-roadmap --strict
git diff --check
```

## 审查与修复记录

第一轮 reviewer 指出模型协议混入 Runtime 字段、缺少事件载荷 Schema、非法输入可能抛裸异常、事件 ID/边界不足、`preservedFacts` 不完整和返回对象存在引用别名；已拆分模型最小结果与 Runtime 元数据，补充专用成功/失败载荷 Schema、输入防御、ID/时间/边界校验、完整必保留事实和深拷贝。

第二轮 reviewer 确认 M1/M2/M3/M6 通过，指出 `firstKeptEntryId` 严格边界、时间单调、失败 ID 冲突和 `intent`/`idempotencyKey` 遗漏；已补充上述门禁和回归测试。

第三轮 reviewer 指出仅剩文件规模、方法拆分、注释比例和 fallback 校验规范问题；已拆分 `compaction-validation.ts`、`compaction-helpers.ts`，将主服务控制在 350 行内并统一 fallback 公共校验。

最终审查结论：独立 reviewer APPROVED；8/8 focused、59/59 full suite、lint/build、OpenSpec strict 和 diff check 均通过。

## 未解决风险

- `ContextCompactionService` 是“校验/规划器”，不会自行追加 EventLog；调用方必须把返回的成功或失败事件和状态快照放入同一持久化事务。
- `references` 的目标验证基于当前上下文和来源事件中的稳定 JSON 字段；自然语言文本事实仍需上层输入事件提供结构化来源。
