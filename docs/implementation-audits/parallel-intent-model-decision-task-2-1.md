# Task 2.1 Implementation Audit

## Scope

新增版本化 Intent Model Prompt builder，要求模型返回与 JEV 相同的 `iar.decision/v1`，复制决策阶段、版本和有序候选，不扩展候选、不授予能力、不授权动作、不执行插件。

## Changed files

- `packages/decision/src/model-gateway/intent-prompt.ts`
- `packages/decision/src/model-gateway/index.ts`
- `tests/integration/model-gateway/intent-prompt.test.ts`
- `tests/integration/model-gateway/intent-prompt-security.test.ts`

## Evidence

- RED/GREEN：先验证 builder/export 与运行时边界缺失，再完成 GREEN。
- 契约 focused tests：8/8 通过。
- 安全 focused tests：9/9 通过。
- 覆盖固定 Prompt 版本、JSON-only、schemaVersion、非 choice 字段约束、候选顺序、深拷贝、有限数值、重复 ID、稀疏数组、toJSON、accessor、非枚举字段、异常脱敏和透明 Proxy。
- `git diff --check`：通过。
- `openspec validate parallel-intent-model-decision --strict`：通过。
- 两阶段 review：spec compliance PASS；code quality PASS。

## Boundary decisions

- Prompt builder 只构造模型输入，不调用 provider，不执行路由和权限判断。
- 输入先通过运行时结构校验，再通过 `structuredClone` 快照和二次校验，避免 Proxy 或 JSON 序列化改变语义。
- 非法输入和底层序列化异常统一转换为稳定 `TypeError`，不传播原始异常正文。
- 公开导出保持在 `model-gateway/index.ts`，下游仍等待后续 adapter 通过统一 `ModelGatewayResult` 接入。

## Known verification limitation

`npm run lint` 和 `npm run build` 在独立 worktree 中仍受既有跨 worktree workspace 类型路径冲突阻断；focused tests、变更文件定向检查与 diff 检查通过。
