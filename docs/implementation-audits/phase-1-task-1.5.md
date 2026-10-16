# Phase 1 Task 1.5 实现审计

## 任务边界

- 模块：`packages/subscriptions/`
- 目标：实现内部 before Hook 与异步 StateEvent 订阅调度。
- 必须覆盖：优先级、过滤、启停、超时、有限重试、fail-open/fail-closed、递归深度、`eventId + subscriptionId` 幂等键和执行证据。
- 排除：远程插件分发、真实 MQ/HTTP 适配器、PostgreSQL、Temporal 和业务 Orchestrator。
- 依赖：Phase 1 contracts、storage、runtime 与 `docs/README.md` 的订阅契约。

## 执行与交接

- 集成分支：`master`
- Task worktree：`.codex/worktrees/chg-001-t5-subscriptions/iar`
- Module agent：只读 `subscription-contract-review`，负责核对 README、YAML 示例、contracts 和测试语义；未修改代码。
- 主线实现范围：`packages/subscriptions/**`、`tests/contract/subscriptions.test.ts`、`package-lock.json`、本审计文件。
- 任务外文件：未修改既有 contracts、storage、runtime 实现。

## TDD 证据

### RED

```text
npm test -- --run tests/contract/subscriptions.test.ts
tests/contract/subscriptions.test.ts(15,8): error TS2307:
Cannot find module '../../packages/subscriptions/src/index.js'
```

失败原因是目标订阅模块尚未实现，不是测试语法或环境错误。

### GREEN 与回归

- focused：13/13 通过。
- contract + replay：50/50 通过。
- broader full suite：51/51 通过。

## 计划-实现一致性

| OpenSpec 要求 | 实现证据 |
| --- | --- |
| before Hook 按 priority 降序串行 | `SubscriptionRegistry.matching()` 排序；`SubscriptionDispatcher.runBefore()` 串行执行并在 blocked 时停止 |
| deny 阻断后续 Hook | 同步 Handler 的 `decision: deny` 产生 `blocked`；测试验证低优先级 Handler 未调用 |
| StateEvent 异步且不阻塞发布方 | `enqueue()` 使用有界 outstanding 计数和微任务边界；测试验证 enqueue 返回前 Handler 未调用 |
| 过滤和通配事件 | `equals`/`in`、canonical JSON 比较、深复制、exact/wildcard 事件字典；测试验证过滤未命中和未知通配子事件 |
| 超时和重试 | AbortSignal、300000ms 定时边界、timeout 不自动重试、普通异常有限重试；测试验证 timeout attempts=1 和 abort |
| 失败策略 | 同步 fail-closed 失败阻断、同步 fail-open 继续、异步 observer deny 只记录不阻断；均有测试 |
| 递归深度和关联链路 | `deriveEvent()` 自动增加 `recursionDepth`、透传 `correlationId`、设置 `causationId`；入口拒绝超限 |
| 订阅幂等 | deferred 占位先于 Handler 调用；重复投递复用成功/失败 Promise；只淘汰 settled 结果，保留在途记录 |
| 执行证据和输入校验 | 记录 event/subscription/handler/correlation/duration/attempt/result/errorCode；拒绝 null、NaN、Infinity、空标识和未知事件 |
| 队列资源边界 | `maxQueueSize` 覆盖排队与在途任务，溢出返回稳定 `queue_full` |

## 领域规则证据

- `backend-reliability-guidelines`：重复投递复用幂等结果；重试有上限和退避；超时有 AbortSignal；队列有容量和稳定失败结果；错误报告使用稳定 errorCode，不暴露原始异常消息。
- `code-review-spec`：新增类/方法包含中文 JSDoc、作者和日期；执行逻辑拆分为 Registry、Dispatcher、execution 和 queue；无远程调用循环；参数和集合资源有边界；无日志实现，因此 logging-specific 条款不适用。
- `logging-boundaries`：本任务未新增生产日志，日志规则不适用；执行结果以结构化报告交给后续 observability 模块。

## 验证命令

```text
npm test -- --run tests/contract/subscriptions.test.ts
npm test -- --run tests/contract tests/replay
npm run lint
npm run build
npm test
npx openspec validate iar-five-phase-roadmap --strict
git diff --check
node -e "import('@iar/subscriptions').then(() => console.log('public subscriptions import: ok'))"
```

## 审查与修复记录

独立审查经历多轮修复回路，发现并修复了异步启动、超时重试副作用、异步 deny、失败幂等伪成功、动态返回值校验、事件字典、队列背压、循环 JSON、容量淘汰和错误码泄露问题；每轮均由同一 reviewer 复审并补充对应边界测试。

最终审查结论：独立 reviewer APPROVED；13/13 focused、50/50 contract+replay、51/51 broader、lint/build、OpenSpec strict、public import 和 diff check 均通过。

## 未解决风险

- `AbortSignal` 是协作式取消；不可信 CPU 密集 Handler 仍需后续 Worker/Sidecar 执行器提供强隔离，这属于 Phase 4 范围。
- 当前订阅幂等缓存是容量受限且满时拒绝新唯一键的进程内实现；跨进程/重启持久化属于后续 service/storage 集成范围。
