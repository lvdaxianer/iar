# Phase 3 Task 3.6 实现计划

## Task boundary and dispatch

- 模块：Phase 3 全量验证、兼容性记录和模型 profile 版本策略文档。
- 责任：运行 `npm run lint && npm run build && npm test`，验证 ModelGateway、Fastify、示例、路由、Workflow 和 replay 共同通过，并记录公开 API 与 profile 版本演进规则。
- 允许修改：`docs/implementation-audits/phase-3-task-3.6*` 和 OpenSpec checklist；不修改 Phase 3 生产实现。
- 依赖：Phase 3.1–3.5 的实现、测试和审计文件。
- 排除范围：真实 provider、HTTP 监听、数据库、远程插件、Phase 4 服务化和 Phase 5 durable workflow。
- RED：本任务不是新增行为；使用当前 master 状态执行全量验证，若发现回归先停止并定位所属已交付任务。
- 聚焦验证：`npm test -- --run tests/integration/model-gateway tests/integration/fastify tests/contract/examples`。
- 广度验证：`npm run lint && npm run build && npm test`。

## Compatibility decisions

1. HTTP envelope、contracts、ModelGateway error code、Plugin Manifest 和 model profile 都使用独立的 `schemaVersion`/`version` 字段；新增字段默认向后兼容，语义破坏必须升级版本。
2. `profileId`、`profileVersion`、`modelVersion`、role 和 structured output schemaId 是审计维度；同一 profileVersion 内不得改变 timeout/retry/fallback/schema 语义。
3. profile 修改采用新版本或新 profileId；旧版本保持可解析和可回放，fallback 必须与 primary 保持相同 role。
4. Fastify API 只返回有限公开投影，新增敏感字段不能进入 response/log；真实模型和网络 provider 不属于本阶段兼容承诺。

## Compatibility matrix and version strategy

| Surface | Current contract | Backward-compatible change | Breaking change and required action |
| --- | --- | --- | --- |
| Fastify HTTP | `/v1`、`iar.fastify-response/v1`、`fastify.v1` | 只增加可选 envelope/data 字段；保留 `traceId`、`runId`、`version`、`data`、`error` 及现有错误码语义 | 删除/改名/改类型、改变 `data`/`error` 互斥关系、改变 HTTP 状态或错误码语义必须发布新的 API/schema version；禁止在 `/v1` 静默改变旧语义 |
| Contracts/Manifest | `iar.dev/v1`、`iar.plugin-manifest/v1` | 新增可选字段且旧 validator/consumer 仍可处理 | 改变必填字段、字段类型、Function ownership、capability 或 policy 语义必须升级 `apiVersion`/`schemaVersion`；未知版本 fail-closed |
| ModelGateway | 稳定 error code、`retryable`、role output schema | 增加新的稳定错误码或可选审计字段；旧错误码语义和 retryability 保持不变 | 改变既有错误码含义、`retryable` 语义、role output 结构或事件语义必须升级对应 schema/version；不得把 provider 原始错误变成公开契约 |
| ModelProfile | `iar.models/v1`、`iar.model-profile/v1` | 增加可选 profile 字段；同一 `profileVersion` 只做等价配置 | timeout/retry/backoff/fallback/structured schema、role 或模型行为变化必须递增 `profileVersion`；需要并行保留或改变身份时创建新 `profileId` |

### Profile migration and replay rules

- `profileId` 表示可审计的配置身份，`profileVersion` 表示其语义版本，`modelVersion` 表示实际模型快照；改变 `modelVersion` 时同步递增 `profileVersion`，避免同版本审计记录指向不同模型行为。
- 已产生的 audit/event 只引用当时的 profile/model 版本；运行中的 Workflow 和 deterministic replay 必须继续使用该版本的可解析配置，不能用当前 primary/fallback 配置覆盖历史版本。
- 新 profile 在启用前必须通过现有 runtime validation；fallback 必须显式存在且与 primary 属于同一 role。版本淘汰需要先完成运行中引用迁移，并保留回滚或重放所需的旧版本记录。
- 当前 Phase 3 仅交付 v1 配置和内存 registry；上述旧版本保留、淘汰和持久化由后续存储/服务化任务实现，本任务不宣称已提供远程版本仓库。

## Broader verification evidence

- `npm run lint`：通过。
- `npm run build`：通过。
- `npm test`：144/144 通过。
- `node --input-type=module -e "await import('@iar/contracts'); await import('@iar/decision'); await import('@iar/runtime'); await import('@iar/workflow'); await import('@iar/plugin-host'); await import('./dist/packages/adapters/fastify/src/index.js')"`：通过，输出 `package imports ok`。
- `openspec validate iar-five-phase-roadmap --strict`：通过。
- `git diff --check`、EOF 与尾随空白检查：通过。
- 当前 Task 3.6 diff 仅包含本审计/策略文档和 OpenSpec checklist，不包含生产代码修改；Phase 4 未纳入验证或范围扩展。
