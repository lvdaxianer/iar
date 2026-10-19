/*
 * 验证 Phase 2 Workflow 的 Action outcome、拒绝和重复结果均写入可重放事件。
 * Policy/confirmation 拒绝必须产生 action.failed，而不能静默丢失安全证据。
 * executor 只在 Action started 事件之后调用，成功结果写入 action.completed。
 * executor 异常写入 action.failed，并保留稳定错误码。
 * duplicate replay 不调用第二次 executor，但仍返回可审计的重复结果事件。
 * LocalWorkflow 的状态事件和 Action 事件必须属于同一个 runId。
 * 事件回放只投影 BehaviorContext，不重新执行 Action。
 * 测试使用固定 clock，eventId 和 occurredAt 都可确定性比较。
 * malformed Action 无法形成合法 EventEnvelope 时不得伪造事件。
 * 本测试不依赖网络、模型、数据库、Temporal 或真实插件。
 * 该测试对应 Task 2.6 的 Action 结果和拒绝路径验收。
 * EventLog 是本地 sink，后续 durable adapter 必须保留相同事件语义。
 * action.failed 的 reasonCode 是 host-safe 的稳定拒绝分类。
 * action.completed 的 reasonCode 可以区分首次成功和 duplicate replay。
 * replayEvents 的 final action status 必须与事件链一致。
 * 未授权拒绝也必须在 Policy Gate 返回前写入失败事件。
 * required capability 缺失时不应出现 action.started。
 * waiting 状态拒绝不应重新预占 idempotency key。
 * terminal 状态只允许已通过 Policy 的 duplicate replay。
 * ledger 异常必须有稳定拒绝事件而不是未捕获异常。
 * malformed Action 不会生成带伪造 runId 的事实事件。
 * 每个 Action 事件都保留 functionId、pluginId 和 idempotencyKey。
 * 事件 payload 只使用 JSON-safe 字段，便于 storage 适配器保存。
 * 事件顺序先记录 started，再记录 completed 或 failed。
 * 测试同时锁定首次执行与重复执行的审计差异。
 * workflow.started 事件固定同一 runId 的回放起点。
 * workflow.transitioned 事件保存当前 step 和 confirmation 快照。
 * action.started 只表示幂等门禁通过，不表示业务成功。
 * action.completed 只在校验后的非 failed 结果出现。
 * action.failed 同时覆盖拒绝、异常、非法结果和状态竞态。
 * 事件 reasonCode 与返回结果 reasonCode 保持可比对。
 * 事件 eventId 由 sink 递增生成，不依赖随机 UUID。
 * fixed clock 让 occurredAt 排序和 fixture 快照稳定。
 * JSON payload 不允许函数、Symbol 或循环对象进入 EventEnvelope。
 * 未知 run 和 run mismatch 的拒绝由调用方结果承载，不伪造事实源。
 * EventLog getter 返回深拷贝，调用方不能篡改内部历史。
 * 该集成测试是 Phase 2 到后续服务化适配器的事件契约基线。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type ActionDefinition, type ActionResult, type EventEnvelope, type WorkflowDefinition } from '@iar/contracts';
import { replayEvents } from '@iar/runtime';
import { LocalWorkflow, WorkflowEventLog, confirmationScopeHash, type WorkflowRequest } from '@iar/workflow';

/**
 * 创建最小 WorkflowDefinition，覆盖 running、waiting 和终态事件。
 * @returns 合法 WorkflowRequest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(): WorkflowRequest {
  const definition: WorkflowDefinition = {
    schemaVersion: SCHEMA_VERSIONS.workflow,
    workflowId: 'event-replay-workflow',
    version: '1.0.0',
    description: 'event replay integration workflow',
    states: ['start', 'executing', 'done'],
    initialState: 'start',
    terminalStates: ['done'],
    transitions: [{ event: 'execute', from: 'start', to: 'executing' }, { event: 'complete', from: 'executing', to: 'done' }]
  };
  return { runId: 'run-events-1', definition };
}

/**
 * 创建需要确认的 ActionDefinition。
 * @param actionId - 稳定 Action 标识
 * @param idempotencyKey - 稳定幂等键
 * @returns 合法高风险 Action
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(actionId = 'action-events-1', idempotencyKey = 'idem-events-1'): ActionDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId, runId: 'run-events-1', functionId: 'dip.service.stop', pluginId: 'dip-api-stop-v1', idempotencyKey, input: { serviceId: 'test1' }, riskLevel: 'high', confirmationRequired: true };
}

/**
 * 创建固定时间的事件日志。
 * @returns 可注入 LocalWorkflow 的事件 sink
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function eventLog(): WorkflowEventLog {
  let tick = 0;
  return new WorkflowEventLog({ clock: () => `2026-10-17T00:00:0${tick++}.000Z`, correlationId: 'corr-events-1' });
}

/**
 * 读取事件载荷中的单个 JSON 字段。
 * @param event - 版本化事件
 * @param key - 载荷字段名
 * @returns 字段值或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function payloadField(event: EventEnvelope, key: string): unknown {
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload[key] : undefined;
}

/* 成功、拒绝和 duplicate 结果都必须有稳定事件，并可重放为 executed。 */
test('records and replays action outcomes and rejection paths', async () => {
  const log = eventLog();
  const workflow = new LocalWorkflow({ eventLog: log });
  const started = workflow.start(request());
  assert.equal(started.ok, true);
  const target = action();
  let calls = 0;
  const executor = () => {
    calls += 1;
    return { schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const, output: { stopped: true } };
  };
  const input = { runId: target.runId, action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor };
  const unauthorized = await workflow.execute({ ...input, authorized: false });
  assert.equal(unauthorized.reasonCode, 'policy_unauthorized');
  const denied = await workflow.execute(input);
  assert.equal(denied.reasonCode, 'confirmation_required');
  assert.equal(calls, 0);
  assert.equal(workflow.confirm({ runId: target.runId, action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:01.000Z' }).ok, true);
  const first = await workflow.execute(input);
  const duplicate = await workflow.execute(input);

  assert.equal(first.value?.status, 'succeeded');
  assert.equal(duplicate.reasonCode, 'action_duplicate');
  assert.equal(calls, 1);
  const events = log.events;
  assert.ok(events.some((event) => event.eventName === 'action.failed' && payloadField(event, 'reasonCode') === 'confirmation_required'));
  assert.ok(events.some((event) => event.eventName === 'action.failed' && payloadField(event, 'reasonCode') === 'policy_unauthorized'));
  assert.ok(events.some((event) => event.eventName === 'action.started'));
  assert.ok(events.some((event) => event.eventName === 'action.completed' && payloadField(event, 'reasonCode') === 'action_duplicate'));
  assert.ok(events.every((event) => event.runId === target.runId));
  assert.deepEqual(events.filter((event) => event.eventName.startsWith('action.')).map((event) => event.eventName), ['action.failed', 'action.failed', 'action.started', 'action.completed', 'action.completed']);
  assert.equal(replayEvents(events).action.status, 'executed');
});

/* executor 异常必须生成 action.started/action.failed，且重复提交不再次调用。 */
test('records executor failure and stable duplicate replay', async () => {
  const log = eventLog();
  const workflow = new LocalWorkflow({ eventLog: log });
  workflow.start(request());
  const target = action('action-events-2', 'idem-events-2');
  const confirm = workflow.confirm({ runId: target.runId, action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:01.000Z' });
  assert.equal(confirm.ok, true);
  let calls = 0;
  const input = { runId: target.runId, action: target, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => { calls += 1; throw new Error('boom'); } };
  const failed = await workflow.execute(input);
  const duplicate = await workflow.execute(input);

  assert.equal(failed.reasonCode, 'action_executor_failed');
  assert.equal(duplicate.reasonCode, 'action_duplicate');
  assert.equal(calls, 1);
  assert.ok(log.events.some((event) => event.eventName === 'action.failed' && payloadField(event, 'errorCode') === 'action.executor_failed'));
  assert.equal(replayEvents(log.events).action.status, 'failed');
});

/* malformed Action/Result 和不存在或错配 run 都不能伪造 Action 事实事件。 */
test('rejects malformed event inputs and does not forge unknown run history', async () => {
  const log = eventLog();
  assert.throws(() => log.actionStarted({} as unknown as ActionDefinition));
  assert.throws(() => log.actionCompleted(action(), {} as unknown as ActionResult));
  assert.equal(log.events.length, 0);
  const workflow = new LocalWorkflow({ eventLog: log });
  workflow.start(request());
  const target = action('action-events-3', 'idem-events-3');
  const unknown = await workflow.execute({ runId: 'missing-run', action: { ...target, runId: 'missing-run' }, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) });
  const mismatch = await workflow.execute({ runId: target.runId, action: { ...target, runId: 'other-run' }, requiredCapabilities: [], grantedCapabilities: [], authorized: true, executor: () => ({ schemaVersion: SCHEMA_VERSIONS.action, actionId: target.actionId, status: 'succeeded' as const }) });

  assert.equal(unknown.reasonCode, 'workflow_not_found');
  assert.equal(mismatch.reasonCode, 'action_run_mismatch');
  assert.equal(log.events.filter((event) => event.eventName.startsWith('action.')).length, 0);
});
