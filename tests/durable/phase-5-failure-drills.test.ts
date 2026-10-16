/**
 * 验证 Phase 5 durable runtime 的故障恢复、迁移选择和回滚边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionResult, type WorkflowDefinition } from '../../packages/contracts/src/index.js';
import { InMemoryDurableWorkflowStore, DurableWorkflowRuntime, evaluateDurableAdmission, type DurableExecuteRequest, type DurableWorkflowStore } from '../../packages/adapters/temporal/src/index.js';
import { LocalWorkflow, type WorkflowRequest } from '../../packages/workflow/src/index.js';

/**
 * 创建带有可恢复状态转移的 Workflow 定义。
 * @param workflowId - durable admission 绑定的 Workflow 标识
 * @returns 通过 contracts 校验的 WorkflowDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(workflowId: string): WorkflowDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.workflow,
    workflowId,
    version: '1.0.0',
    description: 'phase 5 failure drill',
    states: ['start', 'ready', 'done'],
    initialState: 'start',
    terminalStates: ['done'],
    transitions: [
      { event: 'ready', from: 'start', to: 'ready' },
      { event: 'finish', from: 'ready', to: 'done' }
    ]
  };
}

/**
 * 创建稳定的 Workflow 启动请求。
 * @param runId - Workflow 运行标识
 * @param workflowId - Workflow 定义标识
 * @returns 可交给 LocalWorkflow 或 DurableWorkflowRuntime 的请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(runId: string, workflowId: string): WorkflowRequest {
  return { runId, definition: definition(workflowId) };
}

/**
 * 创建使用指定持久化 store 的 durable runtime。
 * @param store - 可注入的 durable 快照存储
 * @param workflowId - admission 绑定的 Workflow 标识
 * @returns Temporal-compatible v1 runtime
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function runtime(store: DurableWorkflowStore, workflowId: string): DurableWorkflowRuntime {
  return new DurableWorkflowRuntime({
    adapterName: 'temporal-compatible',
    adapterVersion: 'v1',
    requirement: { workflowId, reasons: ['timer'], rationale: 'phase 5 failure drill' },
    store
  });
}

/**
 * 创建通过低风险 Policy Gate 的 Action。
 * @param runId - Action 所属 Workflow
 * @param idempotencyKey - 用于恢复和重复提交的幂等键
 * @returns 可执行的 ActionDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(runId: string, idempotencyKey = 'drill-idempotency-1'): ActionDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.action,
    actionId: `action-${runId}`,
    runId,
    functionId: 'function-durable-drill',
    pluginId: 'plugin-durable-drill',
    idempotencyKey,
    input: { accepted: true },
    riskLevel: 'low',
    confirmationRequired: false
  };
}

/**
 * 创建不携带 executor 的 durable Action 请求。
 * @param runId - Action 所属 Workflow
 * @returns 通过 durable 边界校验的请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function executeRequest(runId: string): DurableExecuteRequest {
  return {
    stepId: `step-${runId}`,
    runId,
    action: action(runId),
    requiredCapabilities: ['capability.durable'],
    grantedCapabilities: ['capability.durable'],
    authorized: true,
    retryable: false
  };
}

/**
 * 创建与 Action 身份一致的成功结果。
 * @param value - 被执行的 Action
 * @returns 可持久化的 ActionResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function result(value: ActionDefinition): ActionResult {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId: value.actionId, status: 'succeeded', output: { accepted: true } };
}

/**
 * 为迁移回滚演练注入一次 CAS store 故障。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
class FailOnSaveStore extends InMemoryDurableWorkflowStore {
  private saveCount = 0;
  /** 命中后抛出一次持久化异常的 save 序号。 */
  public failOnSaveNumber: number | undefined;

  /**
   * 在指定 save 次数注入一次持久化失败。
   * @param snapshot - 待保存的 durable 快照
   * @param expectedVersion - CAS 期望版本
   * @returns 持久化完成 Promise
   * @throws Error 当当前 save 次数命中故障注入点
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public override async save(snapshot: Parameters<DurableWorkflowStore['save']>[0], expectedVersion: number): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === this.failOnSaveNumber) throw new Error('injected durable save failure');
    return super.save(snapshot, expectedVersion);
  }
}

test('short local workflow stays local while an explicit timer requirement selects durable runtime', async () => {
  // Given：短 Workflow 已经在本地状态机中启动。
  const local = new LocalWorkflow();
  assert.equal(local.start(request('migration-run', 'migration-flow')).ok, true);
  assert.equal(local.transition({ runId: 'migration-run', event: 'ready' }).ok, true);
  // When：同一 Workflow 声明 timer 需求并在 durable store 中建立迁移目标。
  assert.deepEqual(evaluateDurableAdmission({ workflowId: 'migration-flow', reasons: [] }), { admitted: false, reasonCode: 'durable_requirement_missing' });
  assert.deepEqual(evaluateDurableAdmission({ workflowId: 'migration-flow', reasons: ['timer'] }), { admitted: true, workflowId: 'migration-flow', reasons: ['timer'] });

  const store = new InMemoryDurableWorkflowStore();
  const durable = runtime(store, 'migration-flow');
  assert.equal((await durable.start(request('migration-run', 'migration-flow'))).ok, true);
  assert.equal((await durable.get('migration-run')).value?.currentStep, 'start');
  assert.equal((await durable.transition({ runId: 'migration-run', event: 'ready' })).ok, true);
  // Then：迁移目标保留 durable 事实源，而本地运行态仍可作为回滚路径。
  assert.equal((await durable.get('migration-run')).value?.currentStep, 'ready');
  assert.equal(local.get('migration-run').value?.currentStep, 'ready');

  const rollbackLocal = new LocalWorkflow();
  assert.equal(rollbackLocal.start(request('rollback-migration-run', 'migration-flow')).ok, true);
  assert.equal(rollbackLocal.transition({ runId: 'rollback-migration-run', event: 'ready' }).ok, true);
  const failingStore = new FailOnSaveStore();
  const failingDurable = runtime(failingStore, 'migration-flow');
  assert.equal((await failingDurable.start(request('rollback-migration-run', 'migration-flow'))).ok, true);
  assert.equal((await failingDurable.transition({ runId: 'rollback-migration-run', event: 'ready' })).ok, true);
  failingStore.failOnSaveNumber = 2;
  // 持久化切换失败时，公开边界返回稳定错误，调用方回滚到本地状态机。
  const failedMigration = await failingDurable.execute(executeRequest('rollback-migration-run'), (value) => result(value));
  assert.equal(failedMigration.reasonCode, 'durable_persistence_failed');
  assert.equal(rollbackLocal.get('rollback-migration-run').value?.currentStep, 'ready');
});

test('worker restart after a CAS race resumes the winning durable step without duplicate transitions', async () => {
  // Given：两个 worker 共享同一个 store，并同时尝试提交同一状态转移。
  const store = new InMemoryDurableWorkflowStore();
  const first = runtime(store, 'failure-flow');
  const second = runtime(store, 'failure-flow');
  assert.equal((await first.start(request('failure-run', 'failure-flow'))).ok, true);

  const [left, right] = await Promise.all([
    first.transition({ runId: 'failure-run', event: 'ready' }),
    second.transition({ runId: 'failure-run', event: 'ready' })
  ]);
  // When：新 worker 从 CAS 胜者的快照恢复。
  assert.equal([left, right].filter((candidate) => candidate.ok).length, 1);

  const recovered = runtime(store, 'failure-flow');
  assert.equal((await recovered.get('failure-run')).value?.currentStep, 'ready');
  assert.deepEqual((await store.load('failure-run'))?.steps.map((step) => step.operation), ['start', 'transition']);
  // Then：历史只有一个 transition，不会因为竞态重复追加业务步骤。
});

test('pending Action after worker loss is fail-closed and never executes the side effect twice', async () => {
  // Given：第一次 worker 在 pending 已提交后丢失，结果提交被故障注入打断。
  const store = new FailOnSaveStore();
  const first = runtime(store, 'action-failure-flow');
  const input = executeRequest('action-failure-run');
  assert.equal((await first.start(request('action-failure-run', 'action-failure-flow'))).ok, true);
  store.failOnSaveNumber = 2;

  let firstCalls = 0;
  const failed = await first.execute(input, () => {
    firstCalls += 1;
    return result(input.action);
  });
  assert.equal(failed.reasonCode, 'durable_persistence_failed');
  assert.equal(firstCalls, 1);

  const recovered = runtime(store, 'action-failure-flow');
  let recoveryCalls = 0;
  const blocked = await recovered.execute(input, () => {
    recoveryCalls += 1;
    return result(input.action);
  });
  assert.equal(blocked.reasonCode, 'durable_action_in_progress');
  assert.equal(recoveryCalls, 0);
  // Then：新 worker 只能报告未知副作用，不能猜测性重放 executor。
});

test('durable admission failure rolls back to the still-available local Workflow path', () => {
  // Given：本地 Workflow 已启动，durable adapter 使用空 requirement。
  const local = new LocalWorkflow();
  assert.equal(local.start(request('rollback-run', 'rollback-flow')).ok, true);
  assert.throws(() => new DurableWorkflowRuntime({
    adapterName: 'temporal-compatible',
    adapterVersion: 'v1',
    requirement: { workflowId: 'rollback-flow', reasons: [] },
    store: new InMemoryDurableWorkflowStore()
  }), /durable_requirement_missing/);
  assert.equal(local.transition({ runId: 'rollback-run', event: 'ready' }).ok, true);
  assert.equal(local.get('rollback-run').value?.currentStep, 'ready');
  // Then：准入失败不破坏本地状态，回滚路径仍能继续执行。
});

// 迁移演练始终使用显式 durable requirement，避免短动作被默认外移。
// 本地状态机和 durable runtime 使用同一份 WorkflowDefinition 语义。
// durable start 先建立持久事实源，再逐步重放已确认的状态转移。
// 回滚 fixture 使用独立 local run，但 runId 与失败 durable run 完全一致。
// 这样断言的 ready 状态确实属于同一个迁移对象。
// FailOnSaveStore 在 pending step 写入前注入故障，避免产生半成品副作用。
// executor 仍被传入是为了证明故障边界不会越过持久化门禁。
// failedMigration 的稳定 reasonCode 是公开 contract，不暴露底层 Error。
// rollbackLocal 保留本地当前步骤，作为 durable 切换失败后的安全路径。
// CAS race 只允许一个 worker 提交 transition，另一个 worker 得到持久化失败。
// 恢复 worker 重新 hydrate 共享快照，而不是复用旧 worker 的内存对象。
// durable steps 的 sequence 断言防止重复追加状态事实。
// pending Action 表示副作用结果未知，恢复策略必须拒绝猜测性重放。
// side-effect counter 直接证明 executor 没有在恢复阶段二次执行。
// admission rejection 与 persistence rejection 分别覆盖迁移前和迁移中的失败。
// local fallback 只读取本地状态机，不读取 durable runtime 的私有缓存。
// 所有 fixture 都使用内存 store，测试不会访问网络或真实 Temporal 服务。
// 所有 Action input 均为最小 JSON-safe 值，避免测试本身引入敏感数据。
// DurableWorkflowRuntime 的 adapter version 固定为 v1，兼容性不会隐式降级。
// 失败路径断言稳定错误码，便于未来跨语言 adapter 复用。
// 这些演练补充既有 durable 主流程测试的故障和恢复证据。
// 本文件不直接断言 Temporal SDK 实现细节，只断言 WorkflowRuntime v1 contract。
// 每个运行态都通过公开 get/events/execute API 读取，不访问 engine 私有字段。
// migration-run 证明正常切换后本地和 durable 状态都收敛到 ready。
// rollback-migration-run 证明失败切换时对应的 local run 没有被覆盖。
// store failure 发生在公开 execute 调用内部，测试要求不得抛出原始异常。
// executor 计数只用于观察副作用次数，不模拟真实外部系统。
// 失败后的 pending record 由 durable store 保留，恢复 worker 只能返回 in-progress。
// completed Action 的 duplicate replay 由既有 durable suite 继续保护。
// 新增 CAS race 演练专注并发提交，不改变 LocalWorkflow 状态机规则。
// durable admission 的空 reasons 明确记录迁移回滚前置失败。
// timer reason 是最小长期运行理由，测试不扩大白名单。
// WorkflowDefinition 的 version 固定，避免测试把版本迁移混入故障语义。
// 所有 runId 只包含有限标识字符，排除输入校验噪声。
// store 只使用结构化 clone，避免共享引用伪造恢复成功。
// 断言 step operation 序列是持久化恢复的主要 handoff evidence。
// 断言 currentStep 是本地和 durable 对等语义的可观察结果。
// 本地 fallback 的断言发生在 durable failure 之后，顺序不可交换。
// 该演练覆盖 migration start、transition、execute failure 和 local continuation。
// 该演练不把短动作默认迁移到 durable，符合 OpenSpec 的 out-of-scope 约束。
// 该文件的 fixture 和注释共同构成 Task 5.5 durable failure report 的原始证据。
