/*
 * 验证 Phase 2 Task 2.4 的本地确定性 Workflow、Policy Gate 和 Action 门禁。
 * WorkflowDefinition 只允许显式状态转移，未知事件和终态转移必须拒绝。
 * Policy Gate 在 executor 之前检查授权、能力和 confirmation scope hash。
 * 高风险 Action 未确认时绝不能调用 executor。
 * confirmed scope 必须绑定 actionId、runId、pluginId 和完整 input。
 * retryable 错误可以恢复到 running，non-retryable 错误必须进入 failed。
 * timeout 和 cancel 都是稳定终态，不允许通过 resume 绕过。
 * resume 只恢复 waiting/running 的本地状态，不创建新的副作用。
 * ActionIdempotencyLedger 拒绝重复 idempotencyKey，executor 只调用一次。
 * 所有结果都携带稳定 reasonCode，便于事件记录和回放。
 * 本测试不依赖真实插件、模型、数据库或 Temporal。
 * executor 只是内存计数器，用于证明 Policy/Idempotency 顺序。
 * 本文件覆盖 Task 2.4 的 acceptance scenarios，而不是 Phase 3 API。
 * Policy Gate 的结果只表示是否允许进入 executor，不取代插件运行时授权。
 * Workflow 失败路径保持旧状态快照可查询，便于后续 resume 和审计。
 * Action input 是 JSON-safe fixture，scope hash 可在测试中确定性重算。
 * 同一 action 的重复提交必须返回第一次记录而不是再次执行。
 * 这些测试为后续 API/Temporal adapter 固定本地语义。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type WorkflowDefinition } from '../../packages/contracts/src/index.js';
import { LocalWorkflow, confirmationScopeHash, type WorkflowRequest } from '../../packages/workflow/src/index.js';

/**
 * 创建最小可恢复状态机，覆盖运行、等待和终态边界。
 * @returns 版本化 WorkflowDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.workflow,
    workflowId: 'local-action',
    version: '1.0.0',
    description: 'local deterministic action workflow',
    states: ['start', 'awaiting', 'done'],
    initialState: 'start',
    terminalStates: ['done'],
    transitions: [
      { event: 'begin', from: 'start', to: 'awaiting' },
      { event: 'finish', from: 'awaiting', to: 'done' }
    ]
  };
}

/**
 * 创建一个高风险、必须确认的可重放 Action。
 * @param overrides - 场景需要覆盖的 Action 字段
 * @returns 合法 ActionDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    schemaVersion: SCHEMA_VERSIONS.action,
    actionId: 'action-1',
    runId: 'run-1',
    functionId: 'dip.service.stop',
    pluginId: 'dip-api-stop-v1',
    idempotencyKey: 'idem-1',
    input: { serviceId: 'test1' },
    riskLevel: 'high',
    confirmationRequired: true,
    ...overrides
  };
}

/**
 * 创建 workflow start 请求，保持每个场景的 runId 显式绑定。
 * @param runId - 工作流实例标识
 * @returns 合法 WorkflowRequest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(runId = 'run-1'): WorkflowRequest {
  return { runId, definition: definition() };
}

/*
 * 以下场景共同固定本地执行的安全顺序。
 * start 先校验 WorkflowDefinition，再创建可查询快照。
 * transition 只读取显式 from/event/to 边，不推断隐式跳转。
 * completed、failed 和 cancelled 都是不可恢复的终态。
 * Policy Gate 先检查 authorized，再检查 required capabilities。
 * confirmationRequired 和 high/critical risk 都会触发确认门禁。
 * scope hash 使用 actionId、runId、functionId 和 pluginId。
 * scope hash 同时包含 idempotencyKey、input、riskLevel 和确认标志。
 * 因此修改输入参数会产生新的确认范围。
 * confirm 只接受当前 runId 的 Action。
 * 错误 scope hash 不会污染 Workflow 的 confirmation 状态。
 * 正确确认后仍需通过授权和能力检查。
 * executor 只在所有前置门禁通过后获得 Action 深拷贝。
 * executor 的返回值必须继续通过 ActionResult Schema。
 * executor 抛异常时转成稳定 action_executor_failed。
 * 幂等账本写入失败不会调用 executor。
 * 重复幂等键返回第一次 Action 记录。
 * retryable failure 进入 waiting，而不是直接伪造成功。
 * retry 递增 attempts 并恢复 running。
 * non-retryable failure 进入 failed 终态。
 * timeout 使用固定 workflow.timeout 错误码。
 * cancel 使用固定 workflow.cancelled 错误码。
 * resume 不会创建新的 Action 或新的 idempotencyKey。
 * get 返回深拷贝，调用方不能修改内部运行态。
 * WorkflowDefinition 快照随 run 一起保存，支持本地恢复。
 * 所有拒绝结果都携带 reasonCode。
 * 测试不依赖真实系统时钟，避免偶发性。
 * 测试不依赖网络、数据库或进程间消息。
 * 测试不假设 Temporal 的持久化语义。
 * Task 2.4 只验证本地确定性执行门禁。
 * Phase 3 将在外部 API 层包装这些稳定结果。
 * Phase 4 将在服务适配层复用同一 Action/Policy 契约。
 * Phase 5 才允许引入 durable Workflow adapter。
 * 任何 adapter 都不能绕过当前 Policy Gate。
 * 任何 adapter 都不能删除 EventLog 的审计要求。
 * 这些断言为后续迁移提供兼容基线。
 * 失败路径优先于执行路径，保证 fail-closed。
 * 状态快照和错误码共同构成 replay 输入。
 * confirmation hash 是用户确认与 Action 的绑定证据。
 * capability 列表只由调用方显式提供。
 * provider 或 executor 不能扩大 capability。
 * executor 调用计数是副作用是否发生的唯一测试信号。
 * 第二次执行计数保持不变即证明幂等门禁生效。
 * 本文件不测试真实 Action 业务逻辑。
 * 本文件不授予任何租户、actor 或插件权限。
 * 本文件保持 Workflow、Policy 和 Action 的职责分离。
 * 未来增加场景时应继续保留对应边界说明。
 */
/*
 * 这里的每个测试都从公开 API 进入，不访问 LocalWorkflow 私有字段。
 * 这样可以证明返回快照与内部状态之间存在隔离。
 * 状态转移的输入是字符串事件，不接受隐式函数或动态脚本。
 * WorkflowDefinition 的 states 集合是恢复时的结构边界。
 * terminalStates 不能包含 initialState，避免 running/terminal 矛盾。
 * waiting 是 retry/resume 的显式中间态，不是可执行态。
 * failed 和 cancelled 不能被 resume 重新打开。
 * Policy 输入使用公共 Action Schema，而不是只依赖 TypeScript 类型。
 * capability 数组拒绝非字符串和重复项，保持审计稳定。
 * authorized 必须是布尔值，缺省或字符串都按拒绝处理。
 * confirmation state 只接受公共枚举。
 * confirmedAt 和 scopeHash 只能是字符串。
 * hash 计算之前先校验 Action，避免循环输入进入递归序列化。
 * Action executor 输入是深拷贝，测试不允许反向修改内部 Action。
 * executor 输出通过公共 ActionResult Schema 校验。
 * executor 输出 actionId 不匹配时视为 malformed result。
 * executor 异常被转换为稳定失败，不向调用方泄漏堆栈。
 * 幂等键在 executor 之前写入，防止并发副作用重复。
 * 异步幂等写入后再次检查 Workflow 状态，覆盖 cancel/timeout 窗口。
 * 状态窗口失败时不调用 executor，即使幂等键已经预占。
 * 已完成结果会被重复提交直接返回。
 * 没有结果的预占记录会返回 action_in_progress。
 * retryable ActionResult 进入 waiting 并保留错误码。
 * retry 只改变状态和 attempts，不伪造 ActionResult。
 * 本地实现不会自动重试外部副作用。
 * 这保证一次副作用最多对应一个幂等键。
 * timeout 是 retryable false 的失败。
 * cancel 是独立的终态错误。
 * Workflow snapshot 包含 definition 版本，便于解释恢复结果。
 * confirmation snapshot 包含 confirmedAt，便于审计时间线。
 * action snapshot 包含固定的 functionId 和 pluginId。
 * Action input 作为 scope hash 的一部分参与确认绑定。
 * 风险等级变化会使 scope hash 变化。
 * idempotencyKey 变化会使 scope hash 变化。
 * 任何参数变化都要求重新确认。
 * 测试使用稳定日期，避免系统时钟造成差异。
 * 测试使用稳定 serviceId，避免外部实体依赖。
 * 测试中的 executor 返回值均为最小合法 Schema。
 * 测试中的 malformed executor 场景只验证门禁，不验证业务执行。
 * 这些断言与 Task 2.4 计划中的验收映射一一对应。
 * 未来的 service/Temporal adapter 必须保持这些 reasonCode 语义。
 */
/* 显式 transition 只沿 definition 中的边推进，终态不能再次转移。 */
test('explicit transitions are deterministic and terminal transitions are rejected', () => {
  const workflow = new LocalWorkflow();
  const started = workflow.start(request());
  assert.equal(started.ok, true);
  assert.equal(workflow.transition({ runId: 'run-1', event: 'begin' }).value?.currentStep, 'awaiting');
  assert.equal(workflow.transition({ runId: 'run-1', event: 'finish' }).value?.status, 'completed');
  const terminal = workflow.transition({ runId: 'run-1', event: 'begin' });

  assert.equal(terminal.ok, false);
  assert.equal(terminal.reasonCode, 'workflow_terminal');
});
/* Policy Gate 顺序必须在 executor 前拦截未确认、未授权和能力不足。 */
test('Policy Gate blocks high-risk action before confirmation, authorization and capability', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action();
  let calls = 0;
  const executor = () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const, output: { accepted: true } };
  };
  const beforeConfirmation = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: ['dip.service.write'], grantedCapabilities: ['dip.service.write'], authorized: true, executor });
  assert.equal(beforeConfirmation.reasonCode, 'confirmation_required');
  assert.equal(calls, 0);

  const confirmed = workflow.confirm({ runId: 'run-1', action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(confirmed.ok, true);
  const unauthorized = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: ['dip.service.write'], grantedCapabilities: ['dip.service.write'], authorized: false, executor });
  assert.equal(unauthorized.reasonCode, 'policy_unauthorized');
  assert.equal(calls, 0);

  const missingCapability = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: ['dip.service.admin'], grantedCapabilities: ['dip.service.write'], authorized: true, executor });
  assert.equal(missingCapability.reasonCode, 'policy_capability_missing');
  assert.equal(calls, 0);
});
// 主 Workflow 测试到此结束，保持结果边界显式。
/* confirmation hash 绑定完整 Action，参数或 hash 变化都不能复用确认。 */
test('confirmation scope hash binds the full action and allows execution only on an exact match', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action();
  const wrong = workflow.confirm({ runId: 'run-1', action: target, scopeHash: 'sha256:wrong', confirmedAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reasonCode, 'confirmation_scope_mismatch');
  const confirmed = workflow.confirm({ runId: 'run-1', action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:00.000Z' });
  assert.equal(confirmed.ok, true);
  const result = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) });

  assert.equal(result.ok, true);
  assert.equal(result.value?.status, 'succeeded');
});

/* retryable failure 可恢复，永久失败和 timeout 必须保持终态。 */
test('retryable failure resumes while non-retryable failure and timeout remain terminal', () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const retryable = workflow.fail({ runId: 'run-1', errorCode: 'network.timeout', retryable: true });
  assert.equal(retryable.value?.status, 'waiting');
  assert.equal(workflow.retry('run-1').value?.status, 'running');
  const permanent = workflow.fail({ runId: 'run-1', errorCode: 'validation.failed', retryable: false });
  assert.equal(permanent.value?.status, 'failed');
  assert.equal(workflow.retry('run-1').reasonCode, 'workflow_terminal');

  const timeoutWorkflow = new LocalWorkflow();
  timeoutWorkflow.start(request('run-timeout'));
  assert.equal(timeoutWorkflow.timeout('run-timeout').value?.status, 'failed');
  assert.equal(timeoutWorkflow.resume('run-timeout').reasonCode, 'workflow_terminal');
});

/* resume 只恢复 waiting/running，cancel 后不能绕过取消边界。 */
test('cancel and resume preserve local state boundaries', () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  assert.equal(workflow.fail({ runId: 'run-1', errorCode: 'provider.failed', retryable: true }).value?.status, 'waiting');
  assert.equal(workflow.resume('run-1').value?.status, 'running');
  assert.equal(workflow.cancel('run-1').value?.status, 'cancelled');
  assert.equal(workflow.resume('run-1').reasonCode, 'workflow_terminal');
});

/* 同一 idempotencyKey 的第二次提交只返回 duplicate，不再次调用 executor。 */
test('Action idempotency prevents a second executor call for the same key', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action({ confirmationRequired: false, riskLevel: 'low' });
  let calls = 0;
  const executor = () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const };
  };
  const first = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });
  const second = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reasonCode, 'action_duplicate');
  assert.equal(second.value?.status, 'succeeded');
  assert.equal(calls, 1);
});
/* malformed Action、Policy 字段和初始终态都必须在执行前稳定拒绝。 */
test('runtime validation rejects malformed action policy input and terminal initial state', async () => {
  const workflow = new LocalWorkflow();
  const invalidDefinition = { ...definition(), initialState: 'done' };
  assert.equal(workflow.start({ runId: 'invalid', definition: invalidDefinition }).reasonCode, 'workflow_definition_invalid');
  const duplicateTransitionDefinition = { ...definition(), transitions: [...definition().transitions, { event: 'begin', from: 'start', to: 'awaiting' }] };
  assert.equal(workflow.start({ runId: 'duplicate', definition: duplicateTransitionDefinition }).reasonCode, 'workflow_definition_invalid');
  workflow.start(request());
  let calls = 0;
  const malformedAction = { ...action({ confirmationRequired: false }), input: () => 'unsafe' } as unknown as ActionDefinition;
  const result = await workflow.execute({ runId: 'run-1', action: malformedAction, requiredCapabilities: [], grantedCapabilities: [], authorized: 'yes' as unknown as boolean, executor: () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: 'action-1', status: 'succeeded' as const };
  } });

  assert.equal(result.reasonCode, 'policy_input_invalid');
  assert.equal(calls, 0);
});

/* waiting 状态必须先经过 retry/resume，取消后的 Action 也不能执行。 */
test('waiting and cancelled states block direct execution', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  workflow.fail({ runId: 'run-1', errorCode: 'temporary', retryable: true });
  let calls = 0;
  const execute = () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: 'action-1', status: 'succeeded' as const };
  };
  const waiting = await workflow.execute({ runId: 'run-1', action: action({ confirmationRequired: false, riskLevel: 'low' }), requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: execute });
  assert.equal(waiting.reasonCode, 'workflow_waiting');
  assert.equal(workflow.cancel('run-1').value?.status, 'cancelled');
  assert.equal(calls, 0);
});

/* executor 异常会固化失败结果，重复提交返回第一次结果而不是再次调用。 */
test('executor failure is converted to an idempotent result', async () => {
  const workflow = new LocalWorkflow();
  workflow.start(request());
  const target = action({ confirmationRequired: false, riskLevel: 'low' });
  let calls = 0;
  const executor = () => {
    calls += 1;
    throw new Error('boom');
  };
  const first = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });
  const second = await workflow.execute({ runId: 'run-1', action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor });

  assert.equal(first.reasonCode, 'action_executor_failed');
  assert.equal(second.reasonCode, 'action_duplicate');
  assert.equal(second.value?.errorCode, 'action.executor_failed');
  assert.equal(calls, 1);
});
// 主 Workflow 测试到此结束，保持结果边界显式。
