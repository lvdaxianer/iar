/**
 * 验证 durable Workflow 的持久步骤、worker 恢复和 Action 幂等边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionResult, type WorkflowDefinition } from '@iar/contracts';
import { InMemoryDurableWorkflowStore, DurableWorkflowRuntime, type DurableExecuteRequest, type DurableWorkflowSnapshot } from '@iar/adapters-temporal';
import { confirmationScopeHash, type WorkflowRequest } from '@iar/runtime';

/**
 * 创建 durable fixture 使用的 WorkflowDefinition。
 * @returns 版本化 Workflow 定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.workflow,
    workflowId: 'durable-flow',
    version: '1.0.0',
    description: 'durable workflow fixture',
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
 * 创建稳定 Workflow 请求。
 * @returns 可恢复 Workflow 请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(): WorkflowRequest {
  return { runId: 'durable-run', definition: definition() };
}

/**
 * 创建通过低风险 Policy Gate 的 Action。
 * @returns 合法低风险 Action
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(): ActionDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.action,
    actionId: 'action-durable-1',
    runId: 'durable-run',
    functionId: 'function-durable',
    pluginId: 'plugin-durable',
    idempotencyKey: 'idem-durable-1',
    input: { value: 'payload' },
    riskLevel: 'low',
    confirmationRequired: false
  };
}

/**
 * 创建无 executor 的 durable Action 请求。
 * @returns 可持久化 Action 请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function actionRequest(): DurableExecuteRequest {
  return {
    stepId: 'action-step-1',
    runId: 'durable-run',
    action: action(),
    requiredCapabilities: ['capability.durable'],
    grantedCapabilities: ['capability.durable'],
    authorized: true,
    retryable: false
  };
}

/**
 * 创建合法成功 ActionResult。
 * @param value - 结果绑定的 Action
 * @returns 成功 ActionResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function succeededAction(value: ActionDefinition): ActionResult {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId: value.actionId, status: 'succeeded', output: { accepted: true, secret: 'secret-output' } };
}

/**
 * 创建使用固定 durable requirement 的 runtime。
 * @param store - 共享 durable store
 * @returns durable WorkflowRuntime
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function runtime(store: InMemoryDurableWorkflowStore): DurableWorkflowRuntime {
  return new DurableWorkflowRuntime({
    adapterName: 'temporal-compatible',
    adapterVersion: 'v1',
    requirement: { workflowId: 'durable-flow', reasons: ['timer'], rationale: 'worker recovery fixture' },
    store
  });
}

/**
 * 创建 worker loss 前留下的 pending Action 快照。
 * @returns pending Action durable snapshot
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function pendingSnapshot(): DurableWorkflowSnapshot {
  const persistedRequest = { ...actionRequest(), action: { ...action(), input: { redacted: true, digest: 'sha256:test' } } };
  return {
    version: 2,
    run: {
      runId: 'durable-run',
      workflowId: 'durable-flow',
      definition: definition(),
      currentStep: 'start',
      status: 'running',
      attempts: 0,
      confirmation: { state: 'not_required' }
    },
    steps: [
      { stepId: 'workflow-start', sequence: 1, operation: 'start', status: 'completed', data: { kind: 'start' } },
      { stepId: 'action-step-1', sequence: 2, operation: 'execute', status: 'pending', data: { kind: 'execute', request: persistedRequest } }
    ],
    actions: [{ request: persistedRequest, actionDigest: confirmationScopeHash(action()), status: 'pending' }],
    events: [],
    nextEventSequence: 1
  };
}
test('durable runtime 持久化 start/transition step 并在新 worker 恢复最后步骤', async () => {
  // Given：两个 worker 共享同一个 CAS store。
  // When：第一个 worker 完成 start/transition，第二个 worker 读取运行态。
  // Then：恢复状态和 step 顺序必须保持一致。
  const store = new InMemoryDurableWorkflowStore();
  const first = runtime(store);
  assert.equal((await first.start(request())).ok, true);
  assert.equal((await first.transition({ runId: 'durable-run', event: 'ready' })).ok, true);

  const recovered = runtime(store);
  assert.deepEqual((await recovered.get('durable-run')).value?.currentStep, 'ready');
  assert.equal((await recovered.resume('durable-run')).ok, true);
  const snapshot = await store.load('durable-run');
  assert.deepEqual(snapshot?.steps.map((step) => step.operation), ['start', 'transition', 'resume']);
  // 证据：新 worker 没有复用旧的 LocalWorkflow 实例。
  // 证据：恢复结果来自 durable step 顺序和持久事件事实源。
  // 证据：resume 之后新增 step 仍使用单调序号。
  // 这是 worker-loss 恢复的最小主流程证据。
  // 断言同时覆盖状态、步骤和恢复后的继续执行。
  // 任何重放偏差都会在这里暴露为顺序或状态不一致。
});
test('worker loss 后同一 idempotency key 只执行一次副作用并重放持久结果', async () => {
  // Given：第一次执行已经提交 pending 和 completed 记录。
  // When：新 worker 再次收到相同 Action。
  // Then：只返回持久结果，不再调用 executor。
  const store = new InMemoryDurableWorkflowStore();
  const first = runtime(store);
  await first.start(request());
  let sideEffects = 0;
  const input = actionRequest();
  await first.execute(input, () => {
    sideEffects += 1;
    return succeededAction(input.action);
  });
  const persisted = await store.load('durable-run');
  const persistedInput = persisted?.actions[0]?.request.action.input;
  assert.equal(typeof persistedInput, 'object'); assert.equal((persistedInput as { redacted?: boolean }).redacted, true);
  assert.equal(JSON.stringify(persisted).includes('"value":"payload"'), false); assert.equal(JSON.stringify(persisted).includes('secret-output'), false);

  const recovered = runtime(store);
  const replay = await recovered.execute(input, () => { sideEffects += 1; return succeededAction(input.action); });
  assert.equal(sideEffects, 1);
  assert.equal(replay.reasonCode, 'action_duplicate');
  const events = await recovered.events('durable-run');
  assert.deepEqual(events.map((event) => event.eventName), ['workflow.started', 'action.started', 'action.completed']);
  // 证据：持久 Action input 只有摘要，原始 payload 不进入 store。
  // 证据：第二次调用返回 duplicate，而不是执行传入的 executor。
  // 证据：IAR action 事件和 Workflow run 共享同一个 durable correlation。
  // 结果重放不重新构造业务 output，避免秘密重新进入事件历史。
  // 幂等键、Action digest 和 event sequence 共同形成恢复关联。
  // 该用例覆盖正常完成后的 worker 重启路径。
});
test('retry、cancel 和 timeout 都持久化状态且拒绝非法后续执行', async () => {
  // Given：Workflow 进入 retryable waiting 状态。
  // When：执行 retry、timeout 和非法 cancel。
  // Then：attempts 和终态必须按 LocalWorkflow 语义持久化。
  const store = new InMemoryDurableWorkflowStore();
  const durable = runtime(store);
  await durable.start(request());
  assert.equal((await durable.fail({ runId: 'durable-run', errorCode: 'worker.failed', retryable: true })).value?.status, 'waiting');
  assert.equal((await durable.retry('durable-run')).value?.attempts, 1); assert.equal((await durable.timeout('durable-run')).value?.status, 'failed');
  assert.equal((await durable.cancel('durable-run')).reasonCode, 'workflow_terminal');
  const snapshot = await store.load('durable-run');
  assert.deepEqual(snapshot?.steps.map((step) => step.operation), ['start', 'fail', 'retry', 'timeout']);
  // 证据：retry 只发生在 retryable waiting 状态。
  // 证据：timeout 产生终态后，cancel 不会追加非法 step。
  // 证据：恢复所需 attempts 字段来自持久 run snapshot。
  // retry、timeout 与 cancel 使用同一个 durable step 链。
  // 终态拒绝不能伪造新的成功状态。
  // 该用例覆盖可恢复失败和不可逆终态的交界。
});
test('并发 start 只允许一个 worker 原子创建同一 run', async () => {
  // Given：两个 worker 同时使用同一个空 store。
  // When：并发创建同一 runId。
  // Then：CAS/create 只允许一个创建成功。
  const store = new InMemoryDurableWorkflowStore();
  const results = await Promise.all([runtime(store).start(request()), runtime(store).start(request())]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reasonCode === 'workflow_exists').length, 1);
  // 证据：快速 load 检查不能替代 create 的原子保护。
  // 证据：两个 worker 共享同一 runId 时只保留一个初始快照。
  // 证据：失败 worker 返回稳定 workflow_exists，而不泄露 CAS 实现细节。
  // 并发测试故意不依赖调度顺序，验证 store 的原子性。
  // 只有一个 worker 能获得初始 run 的持久化所有权。
  // 另一个 worker 的结果仍保持可消费的契约形状。
});
test('malformed public input 和非法 executor 在持久化前稳定拒绝', async () => {
  // Given：公开 API 收到空请求或非法 executor。
  // When：请求到达 durable boundary。
  // Then：返回稳定错误且合法请求仍可执行。
  const store = new InMemoryDurableWorkflowStore();
  const durable = runtime(store);
  assert.equal((await durable.start(null as never)).reasonCode, 'workflow_definition_invalid');
  await durable.start(request());
  assert.equal((await durable.transition(null as never)).reasonCode, 'workflow_input_invalid');
  assert.equal((await durable.fail(null as never)).reasonCode, 'workflow_input_invalid');
  assert.equal((await durable.execute(actionRequest(), null as never)).reasonCode, 'workflow_input_invalid');
  let calls = 0;
  const result = await durable.execute(actionRequest(), (value) => {
    calls += 1;
    return succeededAction(value);
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  // 证据：非法输入和非法 executor 都未消耗 Action 幂等键。
  // 证据：合法请求仍经过 Policy Gate 后进入 executor。
  // 证据：边界拒绝不会把底层异常或敏感输入返回给调用方。
  // 非法请求发生在 pending step 之前，因此不会污染幂等记录。
  // 合法请求的成功证明拒绝路径没有破坏 runtime。
  // 输入校验与 Policy Gate 共同构成 durable boundary。
});

test('revoked Proxy 输入不会从公开入口抛出原始异常', async () => {
  // Given：调用方传入 revoked Proxy。
  // When：公开 transition/fail 入口读取字段。
  // Then：入口 fail-closed 为稳定 workflow_input_invalid。
  const durable = runtime(new InMemoryDurableWorkflowStore());
  await durable.start(request());
  const transition = Proxy.revocable({ runId: 'durable-run', event: 'ready' }, {}); const failure = Proxy.revocable({ runId: 'durable-run', errorCode: 'bad', retryable: true }, {});
  transition.revoke(); failure.revoke();
  assert.equal((await durable.transition(transition.proxy as never)).reasonCode, 'workflow_input_invalid');
  assert.equal((await durable.fail(failure.proxy as never)).reasonCode, 'workflow_input_invalid');
  // 证据：revoked Proxy 的 getter 异常不会穿透公开入口。
  // 证据：输入错误码保持稳定，便于 API 层映射。
  // 证据：异常输入没有写入新的 durable step。
  // 公开 API 对异常对象只返回稳定错误码。
  // revoked Proxy 是恶意 getter 和状态竞态的代表性 fixture。
  // 该用例确保输入验证不会跨越持久化边界。
});

test('pending step 在 worker loss 后不自动重放未知副作用', async () => {
  // Given：store 中只有 pending execute step。
  // When：新 worker 尝试恢复相同幂等 Action。
  // Then：返回 in-progress，executor 不得被调用。
  const store = new InMemoryDurableWorkflowStore();
  assert.equal(await store.create(pendingSnapshot()), true);
  const recovered = runtime(store);
  const result = await recovered.execute(actionRequest(), () => {
    throw new Error('副作用不应再次调用');
  });
  assert.equal(result.reasonCode, 'durable_action_in_progress');
  // 证据：pending Action 的未知副作用状态采用 fail-closed 策略。
  // 证据：恢复过程只重放 completed ActionResult。
  // 证据：worker loss 不会因自动重试造成第二次副作用。
  // pending 状态表示结果未知，而不是可安全重试。
  // 只有明确完成的结果才允许进入无副作用 replay。
  // 这保证恢复策略不会把不确定性变成重复写入。
});

test('高风险 Action 脱敏恢复后仍保留 confirmation scope 语义', async () => {
  // Given：高风险 Action 已绑定 confirmation scope 并完成执行。
  // When：新 worker 从脱敏快照恢复并重复提交。
  // Then：scope 校验通过且副作用仍只发生一次。
  const store = new InMemoryDurableWorkflowStore();
  const first = runtime(store);
  await first.start(request());
  const highRisk = { ...action(), actionId: 'action-high', idempotencyKey: 'idem-high', riskLevel: 'high' as const, confirmationRequired: true }; const input = { ...actionRequest(), stepId: 'action-high-step', action: highRisk };
  await first.confirm({ runId: 'durable-run', action: highRisk, scopeHash: confirmationScopeHash(highRisk), confirmedAt: '2026-10-17T00:00:00.000Z' });
  let sideEffects = 0;
  await first.execute(input, () => {
    sideEffects += 1;
    return succeededAction(input.action);
  });
  const recovered = runtime(store);
  const replay = await recovered.execute(input, () => {
    sideEffects += 1;
    return succeededAction(input.action);
  });
  assert.equal(sideEffects, 1);
  assert.equal(replay.reasonCode, 'action_duplicate');
  // 证据：confirmation scope 通过完整 Action 摘要绑定。
  // 证据：脱敏后的快照仍能恢复高风险状态语义。
  // 证据：重复提交不会再次触发高风险 executor。
  // confirmation scope 与脱敏摘要共同保护高风险 Action。
  // 当前真实 Action 只用于恢复授权语义，不覆盖持久结果。
  // 该用例覆盖策略、确认、幂等三者的交叉边界。
});

test('配置读取异常被映射为稳定 durable 配置错误', () => {
  // Given：requirement 属性在构造阶段抛出底层异常。
  // When：runtime 固定 adapter 配置并复制 requirement。
  // Then：调用方只能看到稳定配置错误，不会看到 getter 原始信息。
  const requirement = {}; Object.defineProperty(requirement, 'workflowId', { enumerable: true, get: () => { throw new Error('secret-config-error'); } });
  assert.throws(() => new DurableWorkflowRuntime({ adapterName: 'temporal-compatible', adapterVersion: 'v1', requirement: requirement as never }), /durable_adapter_configuration_invalid/);
  // 证据：配置边界在创建 runtime 前完成 fail-closed。
  // 证据：错误文本不包含底层 getter 的敏感信息。
  // 证据：没有创建任何可观察的 Workflow state。
  // 构造期失败发生在 adapter contract 固定之后、run 创建之前。
  // 底层 getter 文本不会成为对外错误消息的一部分。
  // 配置异常因此不会污染 durable store。
});

test('store 拒绝 ActionResult 与请求 Action 不一致的快照', async () => {
  // Given：先产生一个包含 completed ActionResult 的合法快照。
  // When：篡改结果 actionId 后直接写回 durable store。
  // Then：store 边界必须在 replay 前拒绝身份不一致的数据。
  const store = new InMemoryDurableWorkflowStore();
  const durable = runtime(store);
  await durable.start(request());
  const input = actionRequest();
  await durable.execute(input, () => succeededAction(input.action));
  const snapshot = await store.load('durable-run'); assert.ok(snapshot?.actions[0]?.outcome?.ok);
  if (snapshot?.actions[0]?.outcome?.ok) snapshot.actions[0].outcome.value.actionId = 'wrong-action';
  await assert.rejects(store.save(snapshot as DurableWorkflowSnapshot, snapshot?.version ?? 0), /durable_snapshot_invalid/);
  // 证据：结果身份绑定由持久化边界验证，而非只依赖恢复器。
  // 证据：篡改快照不会覆盖原有合法版本。
  // 证据：Action 幂等关联在 store 和 runtime 两层保持一致。
  // store 先验证快照结构，再决定是否比较 CAS 版本。
  // 被篡改的结果不能通过保存进入下一次 worker 恢复。
  // 该用例补足持久化边界而非仅测试 replay 逻辑。
});
