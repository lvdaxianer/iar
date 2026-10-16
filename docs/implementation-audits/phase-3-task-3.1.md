# Phase 3 Task 3.1 实现审计

## 结论

- 状态：通过，可交接 Phase 3 Task 3.2。
- 范围：`config/models.yaml`、`packages/decision/src/model-profile.ts`、decision barrel export、模型 gateway focused tests。
- 未实现：真实模型 SDK、API key 读取/发送、HTTP/Fastify、真实 provider fallback 调度和 prompt 模板。

## 实现结果

- 建立 `iar.models/v1` 配置和 `iar.model-profile/v1` profile，覆盖 semantic.extract、function.select、plugin.select、context.compact、response.generate 五类 role 的 primary/fallback 配置。
- 固化 `profileVersion`、`modelVersion`、timeout、有限 retryPolicy、fallbackProfileId 和 structured output schemaId。
- `ModelProfileRegistry` 对顶层/profile/retry/structured output 字段采用白名单校验，拒绝重复 profile、非法版本/资源边界、缺失 fallback 和跨 role fallback，并返回深拷贝。
- `redactModelRequest` 只接受有限 JSON 值，递归替换 API key、授权、token、secret、password、cookie、credential、private key、raw prompt/user input 等字段，不修改原对象；循环引用和非 plain 对象 fail-closed。
- `ModelAuditRecorder` 运行时校验 input、role、fallbackUsed、outcome、attempt 和 metadata，只输出实际 primary/fallback 的 profile/model 版本与脱敏 metadata。

## RED -> GREEN 证据

- RED：focused 测试首先因 decision 包尚未导出 `ModelProfileRegistry`、`ModelAuditRecorder`、`loadModelProfiles` 和 `redactModelRequest` 而失败。
- GREEN：实现后 focused 通过 3/3，覆盖版本化加载、非法配置、未知字段、跨 role fallback、实际 fallback 审计、敏感字段、非 JSON 输入、null audit input、非法 fallbackUsed、共享引用脱敏。

## 验证与审查

- `npm test -- --run tests/integration/model-gateway`：3/3 通过。
- `npm run lint`：通过。
- `npm run build`：通过。
- `npm test`：118/118 通过。
- decision package import：通过。
- `openspec validate iar-five-phase-roadmap --strict`：通过。
- `git diff --check` 与 untracked diff check：通过。
- canonical reviewer：PASS；MUST/SHOULD 均无。此前提出的未知字段、非 JSON 对象、敏感字段、fallback 版本、输入类型和 JSDoc/分支注释问题均已修复并回归覆盖。

## 安全边界

- API key、authorization、raw prompt、raw user input、password、cookie、credential、private key 不进入 audit entry。
- audit metadata 在脱敏前后均受 JSON runtime boundary 约束，Date、Map、Set、BigInt、函数、循环引用不会被静默写入日志。
- 本任务只提供配置和审计 contract；后续 ModelGateway 必须复用 registry/recorder，不能绕过脱敏入口记录 provider 请求。
