# Phase 3 Task 3.6 实现审计

## 结论

- 状态：通过，Phase 3 全部任务完成，可进入 Phase 4。
- 范围：Phase 3.1–3.5 的 broader verification、API compatibility matrix 和 Model Profile version strategy。
- 未实现：Phase 4 服务化/隔离执行、Phase 5 durable/remote extensions，以及真实 provider 版本仓库。

## Broader verification

- `npm run lint`：通过。
- `npm run build`：通过。
- `npm test`：144/144 通过。
- focused model/API/example matrix：29/29 通过。
- package imports：contracts、decision、runtime、workflow、plugin-host 和 Fastify 构建入口通过。
- `openspec validate iar-five-phase-roadmap --strict`：通过。
- `git diff --check`、EOF 与尾随空白检查：通过。

## Compatibility and version strategy

- Fastify `/v1`、`iar.fastify-response/v1` 和 `fastify.v1` 的 envelope 字段保持稳定；新增可选字段兼容，删除/改名/类型或错误语义变化必须升级 API/schema version，不能在 `/v1` 静默破坏。
- `iar.dev/v1`、`iar.plugin-manifest/v1`、ModelGateway stable error code 和 role output schema 采用同样的 fail-closed 版本策略；未知版本拒绝进入运行时。
- Model Profile 以 `profileId` 表示配置身份、`profileVersion` 表示语义版本、`modelVersion` 表示模型快照；timeout/retry/backoff/fallback/structured schema/role 变化必须升级 profileVersion，必要时创建新 profileId。
- audit/event 固定引用当时的 profile/model 版本；deterministic replay 不得用当前 primary/fallback 覆盖历史版本。fallback 必须与 primary 属于同一 role，并通过现有 registry 校验。
- 当前 Phase 3 只承诺 v1 配置和内存 registry；旧版本持久化、淘汰、迁移和回滚由后续存储/服务化任务实现。

## 审查结论

- canonical reviewer：PASS；MUST/SHOULD 均无。
- 本任务未修改生产代码；OpenSpec Task 3.6 已勾选，Phase 4 未提前实现。
