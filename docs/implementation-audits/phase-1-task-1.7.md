# Phase 1 Task 1.7 实现审计

## 任务边界

- 模块：`examples/fake-plugin/`、`scripts/run-fake-plugin-demo.mjs`、Phase 1 contract/replay 测试和插件文档样例。
- 目标：交付可安装、启停、执行、卸载、重放的 fake plugin 演示，并同步可执行文档。
- 必须覆盖：Manifest Function/能力/确认策略、SDK Handler、输入输出 Schema、生命周期 Hook、PluginHost 状态事件、卸载后能力撤销、EventLog replay。
- 排除：真实 DIP API、网络、模型 Provider、外部进程和真实副作用。

## 执行与交接

- 集成分支：`master`
- Task worktree：`.codex/worktrees/chg-001-t7-phase1-demo/iar`
- Module agent：无额外只读模块 agent；现有 PluginHost/SDK/Runtime 契约已在 Phase 1.1–1.6 审计中完成，本任务使用独立 reviewer 审查演示闭环。
- 独立 reviewer：同一 reviewer 经三轮修复复审，最终 APPROVED；审查期间未修改代码。
- 主线实现范围：`examples/fake-plugin/**`、`scripts/run-fake-plugin-demo.mjs`、`package.json` demo script、fake plugin contract test、README/reference 文档、Task 1.7 audit。

## TDD 证据

### RED

```text
npm install && npm test -- --run tests/contract/fake-plugin-demo.test.ts
tests/contract/fake-plugin-demo.test.ts(11,32): error TS2307:
Cannot find module '../../examples/fake-plugin/src/index.js'
```

首次运行仅因干净 worktree 缺少 `node_modules` 被 `tsc: command not found` 阻断；安装依赖后取得上述真实 RED，原因是 fake plugin 演示模块尚未实现。

### GREEN 与回归

- fake plugin focused：2/2 通过。
- Phase 1 contract/replay focused：60/60 通过。
- full suite：61/61 通过。
- `npm run demo:fake-plugin`：成功输出 6 个生命周期事件和重放最后事件 ID。
- 独立 reviewer：最终 APPROVED，无 Critical/Major/Minor。

## 计划-实现一致性

| OpenSpec 要求 | 实现证据 |
| --- | --- |
| 可安装 fake plugin | `fakeStopPlugin` 使用版本化 Manifest、Function 归属 `dip.service.stop`、能力 `dip.service.write` 和依赖空列表；测试调用 `PluginHost.install()` |
| 可启停/卸载 | 测试和 demo 调用 `enable` → Handler → `disable` → `unload`；卸载后 `get` 为空、`candidates` 为空 |
| 生命周期 Hook 可绑定 | Manifest entrypoint 指向 `./dist/examples/fake-plugin/src/index.js`，并实际导出 `onLoad/onEnable/onDisable/onUnload`；测试逐一调用导出 Hook |
| Handler 输入输出契约 | Handler 拒绝 null/数组/缺失 serviceId/额外字段；输出 Schema 用 `oneOf` 区分 accepted=true + serviceId 和 accepted=false + errorCode；测试通过 Ajv 校验两条返回路径 |
| 事件历史保留 | Host.history 保留 discovered、validated、installed、enabled、disabled、unloaded 六个事件；卸载不删除历史 |
| 确定性重放 | 测试两次执行 `replayEvents(host.events)` 并深比较完整状态；demo 直接从构建产物执行同样重放 |
| 文档样例同步 | `docs/references/fake-plugin-demo.md` 说明 `npm run demo:fake-plugin`、真实 dist 路径、Handler 输出和 draining/disabled 卸载前置；README 已增加链接 |

## 领域规则证据

- `backend-reliability-guidelines`：fake Handler 不产生真实副作用；输入输出 JSON Schema 有边界；失败路径返回稳定 errorCode；生命周期事件保留可审计历史。
- `code-review-spec`：新增函数带中文 JSDoc、作者、日期和边界注释；测试和 demo script 已拆分并达到注释比例门禁；无隐藏网络、数据库或线程副作用。
- `logging-boundaries`：demo 只输出生命周期和重放边界，不输出敏感输入、密钥或原始异常。

## 验证命令

```text
npm test -- --run tests/contract tests/replay
npm run demo:fake-plugin
npm run lint
npm run build
npm test
npx openspec validate iar-five-phase-roadmap --strict
git diff --check
```

## 审查与修复记录

第一轮 reviewer 指出 Manifest entrypoint/Hook 不真实、Handler 未执行额外字段边界、文档路径不能直接运行；已补真实构建产物 entrypoint、四个可调用 lifecycle Hook、严格输入检查和 `scripts/run-fake-plugin-demo.mjs`。

第二轮 reviewer 指出输出 Schema 允许 accepted/serviceId/errorCode 非法组合，并要求补齐方法注释和注释比例；已用 `oneOf` 表达成功/失败分支，使用 Ajv 验证 Handler 输出，并补齐 fake plugin、测试和 demo script 的规范注释。

第三轮 reviewer 仅指出 demo script 注释比例略低于 40%；已补充候选解析、disabled/unload、历史重放和输出说明，最终审查 APPROVED。

## 未解决风险

- 当前 PluginHost 负责状态转移和事件记录，不会自动调用 Manifest 中的 lifecycle Hook；演示测试验证 Hook 导出和可调用性，实际 Hook 调度属于后续 executor/host 扩展范围。
- `npm run demo:fake-plugin` 依赖构建产物，脚本已显式先执行 `npm run build`；文档不承诺直接运行源码 `.js` 路径。
