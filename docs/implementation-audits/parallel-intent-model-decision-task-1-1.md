# Task 1.1 Implementation Audit

## Scope

为 `function.select` 和 `plugin.select` 增加 `DecisionBackend` 配置边界，并校验同一 `role/backend` 的 primary、fallback 关系；保留未声明 backend 的既有 selection 配置兼容。

## Changed files

- `packages/decision/src/types.ts`
- `packages/decision/src/model-profile.ts`
- `tests/integration/model-gateway/model-profile.test.ts`

## Evidence

- RED：新增校验前，focused profile 测试中 13/16 通过、3 项因 fallback 环和字段边界未实现而失败；最后一轮新增校验前为 12/16 通过、4 项失败。
- GREEN：`node scripts/run-tests.mjs tests/integration/model-gateway/model-profile.test.ts`，16/16 通过。
- `git diff --check`：通过。
- `openspec validate parallel-intent-model-decision --strict`：通过。
- 两阶段 review：spec compliance PASS；code quality PASS。

## Boundary decisions

- `DecisionBackend` 仅允许 `jev` 和 `intent-model`。
- 非 selection role 不得携带 backend 字段，包括 own `undefined`。
- 旧配置中 selection profile 完全缺失 backend 时，关系校验内部按兼容 JEV 分组，但不改写返回 profile；显式 backend 配置要求同一 selection 配置完整声明。
- backend 的 JEV 优先选择由后续 `DecisionBackendResolver` 负责，本任务不修改 `forRole()`。

## Known verification limitation

`npm run lint` 和 `npm run build` 在该独立 worktree 中仍被既有跨 worktree workspace 类型路径冲突阻断（`PluginHost`、`LocalWorkflow` 等私有字段出现 duplicate declaration）；focused 产物测试和变更源文件检查均通过，未发现本任务文件引入的类型错误。

## Open items

- Task 1.2 将实现 backend-aware resolver，验证 JEV 优先、仅 Intent Model 和无 backend 的稳定配置错误。
