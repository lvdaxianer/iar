# Task 1.2 Implementation Audit

## Scope

新增 `DecisionBackendResolver`，固定 JEV 优先、Intent Model 其次，并返回稳定的 `model.no_profile` 配置错误；不改变 DecisionResult、ModelGateway 或路由调用边界。

## Changed files

- `packages/decision/src/model-gateway/decision-backend.ts`
- `packages/decision/src/model-gateway/index.ts`
- `tests/integration/model-gateway/decision-backend.test.ts`

## Evidence

- RED：新增 resolver 测试在 resolver 导出与实现缺失时失败。
- GREEN：`node scripts/run-tests.mjs tests/integration/model-gateway/model-profile.test.ts`，16/16 通过；`node scripts/run-tests.mjs tests/integration/model-gateway/decision-backend.test.ts`，5/5 通过。
- 覆盖 JEV 优先、仅 Intent Model、无 backend 稳定错误、legacy JEV 兼容和 fallback 不被选。
- `git diff --check`：通过。
- `openspec validate parallel-intent-model-decision --strict`：通过。
- 两阶段 review：spec compliance PASS；code quality PASS。

## Boundary decisions

- resolver 只返回一个 primary backend，不并行调用或暴露另一个 backend。
- 完全缺失 `decisionBackend` 的旧 selection profile 在 resolver 中按兼容 JEV 处理，但不改写 registry profile。
- `forRole()` 未改动；后续 adapter 通过 resolver 获取 backend，避免按 profile 数组顺序隐式选择。

## Known verification limitation

`npm run lint` 和 `npm run build` 在独立 worktree 中仍受既有跨 worktree workspace 类型路径冲突阻断；变更源文件严格 TypeScript 检查、focused tests 与 diff 检查通过。
