# Phase 5 Task 5.1 Per-task Audit

## Scope

本任务只建立长流程准入门槛和 `WorkflowRuntime` v1 contract，未改写
`LocalWorkflow`，未执行持久化副作用，也未接入 Temporal worker。允许进入
durable adapter 的原因固定为 `timer`、`cross_service` 和 `compensation`；
短动作和缺少明确理由的 Workflow 继续留在本地状态机边界。

## Boundary and evidence

- Allowed implementation scope: `packages/adapters/temporal/**`。
- Allowed test scope: `tests/durable/**`。
- Supporting workspace metadata: `package-lock.json`。
- Supporting plan and audit: `docs/superpowers/plans/2026-10-17-phase-5-task-5.1-durable-admission.md`、本文件。
- Out of scope: step persistence、retry/cancel/timeout、worker-loss resume、远程分发、ABI 和 control plane；这些属于后续 Task 5.2–5.4。

## TDD evidence

1. RED：首次执行 `npm test -- --run tests/durable` 时，TypeScript 编译因
   durable 模块尚不存在而失败，错误为 `TS2307`，证明测试先于生产实现。
2. GREEN：实现后 focused suite 通过，最终为 7/7。
3. 回归：全量 suite 最终为 188/188，无失败、取消或跳过。

## Implementation evidence

- `evaluateDurableAdmission` 对空理由返回
  `durable_requirement_missing`，对未知 reason 或非法 `rationale` 返回
  `durable_requirement_invalid`，并对 reason 去重、固定排序。
- `ContractWorkflowRuntime` 固定 `adapterVersion: 'v1'`，创建时拒绝空名称和
  非 v1 配置；`start` 只校验 WorkflowDefinition，稳定返回
  `durable_adapter_not_implemented`，不创建本地 run、不执行 Action、不绕过
  Policy Gate。
- 公开输入边界捕获恶意 getter、revoked Proxy 和 Schema 校验异常，统一
  fail-closed；不向调用方泄露原始异常。
- `package-lock.json` 已登记 `@iar/adapters-temporal` workspace，
  `npm ci --dry-run` 成功。

## Review and verification

- Canonical reviewer: Jason，agent ID
  `01a145f5-635c-7233-bf74-618522bf8cb8`。
- Review result: PASS。
- Domain review applied: canonical `code-review-spec`、
  `backend-reliability-guidelines`；覆盖中文分支注释、输入校验、稳定错误、
  fail-closed、公共契约和可复现安装。
- Commands passed:

  ```text
  npm ci --dry-run
  npm run lint
  npm run build
  npm test -- --run tests/durable
  npm test
  openspec validate iar-five-phase-roadmap --strict
  git diff --check
  ```

## Consistency result

计划中声明的 durable package、focused tests、lockfile、audit 和后续边界均已
落地；没有引入 Task 5.2–5.4 的实现。Task 5.1 通过 per-task audit，可以勾选
唯一对应的 OpenSpec checkbox。
