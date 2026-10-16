# Phase 3 Task 3.2 实现审计

## 结论

- 状态：通过，可交接 Phase 3 Task 3.3。
- 范围：`packages/decision/src/model-gateway/`、decision barrel export、ModelGateway integration tests。
- 未实现：真实模型 SDK、API key 读取/发送、HTTP/Fastify、真实网络 provider，以及后续 API/示例插件业务编排。

## 实现结果

- 建立统一 `ModelGateway` provider 边界，覆盖 Semantic Extractor、JEV Function Decision、JEV Plugin Decision、Context Compactor 和 Response Generator 五类 role。
- provider registry 只接受 own-property 且 `complete` 为函数的 provider；恶意 getter、Proxy、同步返回值、provider 异常和未知 provider 均 fail-closed 为稳定错误。
- 每次调用在 gateway 入口创建结构化、递归冻结的 invocation 快照；profile、input 和 retry limit 不受 provider 或 caller 在重试退避期间的修改影响。
- 统一实现 timeout、AbortSignal、profile 限定的 retry/backoff、primary/fallback 路径、稳定错误码和 `model.completed`/`model.failed` 事件。
- adapter 在 provider 输出进入业务层前执行严格 schema/contract validation；Decision threshold rejection 保留为不可执行的合法拒绝结果，Decision/Compaction/Response 输出均隔离 provider 的迟到变更。
- 所有 audit metadata 复用 Phase 3.1 的 `ModelAuditRecorder` 脱敏入口，不把原始 provider 异常、prompt、credential 或未验证 raw output 写入公开错误和事件。

## RED -> GREEN 证据

- RED：focused tests 首先因 decision package 尚未导出 `model-gateway/index.js` 而失败；安装 workspace 依赖后错误保持为真实模块缺失和相关类型缺失，而非环境误报。
- GREEN：实现后 ModelGateway focused suite 通过；覆盖五类 role、fallback/retry、timeout/abort、schema invalid、threshold rejection、provider own-property 校验、同步 provider、恶意 getter/Proxy、backoff caller mutation、不可 clone 输入和迟到 output mutation。

## 验证与审查

- `npm run lint`：通过。
- `npm run build`：通过。
- ModelGateway focused tests：13/13 通过。
- `npm test`：128/128 通过。
- `openspec validate iar-five-phase-roadmap --strict`：通过。
- `git diff --check`、EOF/尾空白检查：通过。
- canonical reviewer：PASS；MUST/SHOULD 均无。reviewer 重点确认 provider fail-closed、快照/输出隔离、有限 retry/backoff、Promise/timeout 边界、JSDoc、分支注释和文件规模。

## 安全边界

- Provider 只能读取冻结的 profile/input 快照，不能修改 retryPolicy、模型 profile 或调用方对象。
- timeout 会触发请求级 `AbortSignal`；同步 provider 返回值不会被当作成功的异步 provider 结果。
- schema、threshold、provider、timeout 和 fallback 失败均通过稳定错误码和审计事件表达，details 不携带原始异常正文。
- 本任务不建立真实网络调用，也不新增凭据存储或模型 SDK 依赖；后续接入必须继续复用 registry、gateway 和脱敏 recorder 边界。
