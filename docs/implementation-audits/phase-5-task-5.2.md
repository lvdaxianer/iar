# Phase 5 Task 5.2 Per-task Audit

## Scope

Task 5.2 实现 Temporal-compatible durable adapter 的持久步骤、Action 幂等关联、IAR 事件关联、retry/cancel/timeout/fail/resume 和 worker-loss recovery。实现保持短动作的本地 runtime 语义，并通过显式 durable requirement 才进入该 adapter。

## TDD evidence

- RED：先建立 worker-loss、step persistence、Action duplicate、retry/cancel/timeout 和 pending-action fixture；初始实现缺少 durable runtime/store，因此 focused command 未通过。
- GREEN：`tests/durable/durable-workflow-runtime.test.ts` 当前 10 个 focused tests 全部通过，覆盖 start/transition/resume、completed Action replay、CAS 并发 start、非法输入、revoked Proxy、pending action、高风险 confirmation scope、配置异常和 ActionResult 身份篡改。
- Full suite：`npm test` 通过 198/198。

## Behavior trace

1. `start` 先校验 WorkflowDefinition 与 durable admission，再通过 `DurableWorkflowStore.create` 原子保存 start step 和 `workflow.started` event。
2. `transition`、`confirm`、`fail`、`retry`、`timeout`、`cancel`、`resume` 委托 `LocalWorkflow`，成功后使用 expectedVersion CAS 保存脱敏 run、completed step 和新增事件。
3. `execute` 在 Policy Gate 和 executor 边界校验后，先保存 pending execute step；只有 executor 返回结果后才保存 completed Action、脱敏 outcome 和 action events。
4. 新 worker 从 step sequence 重放 LocalWorkflow；completed Action 使用持久结果的无副作用 executor，pending Action 返回 `durable_action_in_progress`，不自动猜测未知副作用。
5. 已完成 Action 使用 idempotency key + full Action digest 关联，并在重复调用前重新经过 Policy Gate；事件使用 adapter/run/sequence 生成稳定 durable event id。

## Safety and reliability evidence

- Store `create` 原子拒绝重复 run，`save` 使用 expectedVersion CAS；缓存会在 CAS/持久化异常后失效。
- Snapshot boundary 校验 run status、confirmation、lastError、actionStatus、step sequence、Action request/outcome 身份绑定、event sequence、跨 run 归属和公共 contract。
- Action input、Action output、event input/output 仅保存 `sha256:` 摘要；测试确认 raw payload 和 `secret-output` 不进入持久快照。
- 公共入口对 malformed input、revoked Proxy、配置 getter 和不可克隆对象 fail-closed，返回稳定错误，不泄露底层异常文本。
- Jason reviewer `01a145f5-635c-7233-bf74-618522bf8cb8` 最终结论：PASS；所有 MUST gate 通过。

## Verification record

```text
npm test                                      PASS 198/198
npm run lint                                  PASS
npm run build                                 PASS
npm ci --dry-run                              PASS
git diff --check                              PASS
openspec validate iar-five-phase-roadmap --strict PASS
Jason review                                  PASS
```

## Audit conclusion

Task 5.2 的实现、测试、计划一致性、领域审查和验证门禁均已完成，可以勾选 OpenSpec 5.2，并创建独立提交合并回 `master`。
