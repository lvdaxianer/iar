/**
 * 验证成功 Action 输出只把契约允许的有限字段投影为可信事实。
 * 失败事件、未公开字段和其他会话不能污染事实集合。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateContract, type EventEnvelope } from '@iar/contracts';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from '@iar/runtime';
import { jobMonitorHandler } from '../../examples/agent-sandbox/src/functions/job-monitor.js';
import { ticketCreateHandler } from '../../examples/agent-sandbox/src/functions/ticket-create.js';
import { humanTransferHandler } from '../../examples/agent-sandbox/src/functions/human-transfer.js';
import { succeed } from '../../examples/agent-sandbox/src/functions/common.js';

/** 创建最小动作事件，测试只使用事件契约允许的 JSON 字段。 */
function actionEvent(eventId: string, eventName: 'action.completed' | 'action.failed', payload: Record<string, unknown>): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId,
    eventName,
    occurredAt: '2026-10-19T00:00:00.000Z',
    runId: 'run-facts',
    correlationId: 'corr-facts',
    payload
  } as EventEnvelope;
}

test('成功 Action 只投影有限公开字段并保留来源', () => {
  const projector = new BehaviorContextProjector();
  projector.apply(actionEvent('evt-ticket-created', 'action.completed', {
    actionId: 'action-1', functionId: 'ticket.create', pluginId: 'ticket-create-v1', resultStatus: 'succeeded',
    output: { accepted: true, operation: 'create', ticketId: 'ticket-001', receipt: 'ticket-001', title: '网络故障', secretToken: 'must-not-enter', facts: { operation: 'create', ticketId: 'ticket-001', receipt: 'ticket-001' } }
  }));
  const context = projector.current();
  assert.equal(context.factHistory?.records[0]?.values.ticketId, 'ticket-001');
  assert.equal(context.factHistory?.records[0]?.sourceEventId, 'evt-ticket-created');
  assert.equal(context.factHistory?.records[0]?.values.receipt, 'ticket-001');
  assert.equal(context.factHistory?.records[0]?.values.secretToken, undefined);
  assert.equal(context.integrity.criticalFieldHash, criticalFieldHash(context));
});

test('失败或待确认路径不产生成功事实，旧事实保持可追溯', () => {
  const projector = new BehaviorContextProjector();
  projector.apply(actionEvent('evt-success', 'action.completed', {
    functionId: 'job.monitor', pluginId: 'job-monitor-v1', resultStatus: 'succeeded',
    output: { accepted: true, operation: 'status', jobName: '订单汇总日报', status: 'success', facts: { operation: 'status', jobName: '订单汇总日报', status: 'success' } }
  }));
  projector.apply(actionEvent('evt-failed', 'action.failed', {
    functionId: 'ticket.create', pluginId: 'ticket-create-v1', errorCode: 'ticket.failed'
  }));
  const records = projector.current().factHistory?.records ?? [];
  assert.equal(records[0]?.values.jobName, '订单汇总日报');
  assert.equal(records.some((record) => record.values.ticketId !== undefined), false);
});

test('每个投影器只维护自己的事实集合', () => {
  const first = new BehaviorContextProjector(createInitialContext('run-first'));
  const second = new BehaviorContextProjector(createInitialContext('run-second'));
  first.apply(actionEvent('evt-first', 'action.completed', {
    functionId: 'ticket.create', pluginId: 'ticket-create-v1', resultStatus: 'succeeded',
    output: { accepted: true, operation: 'create', ticketId: 'ticket-first', facts: { operation: 'create', ticketId: 'ticket-first' } }
  }));
  assert.equal(first.current().factHistory?.records[0]?.values.ticketId, 'ticket-first');
  assert.equal(second.current().factHistory?.records.length, 0);
});

test('真实多业务 Handler 只把显式事实信封投影到上下文', async () => {
  const result = await jobMonitorHandler({ operation: 'status', query: '订单汇总日报', params: {} }, { pluginId: 'job-monitor-v1', functionId: 'job.monitor', runId: 'run-facts', correlationId: 'corr-facts' });
  const projector = new BehaviorContextProjector();
  projector.apply(actionEvent('evt-job-status', 'action.completed', {
    functionId: 'job.monitor', pluginId: 'job-monitor-v1', resultStatus: 'succeeded', output: result.output
  }));
  const record = projector.current().factHistory?.records[0];
  assert.equal(record?.values.jobName, '订单汇总日报');
  assert.equal(record?.values.status, 'success');
  assert.equal(record?.values.job, undefined);
});

test('工单自由文本和描述不会进入可信事实信封', async () => {
  const result = await ticketCreateHandler({ operation: 'create', query: '请创建工单，密码=secret-token', params: { title: '用户私密标题 secret-token' } }, { pluginId: 'ticket-create-v1', functionId: 'ticket.create', runId: 'run-facts', correlationId: 'corr-facts' });
  const output = result.output as Record<string, unknown>;
  const facts = output.facts as Record<string, unknown>;
  assert.equal(facts.title, undefined);
  assert.equal(facts.description, undefined);
  assert.match(String(facts.ticketId), /^ticket-20261018-\d{3}$/);
});

test('BehaviorContext 契约拒绝无界或复合事实值', () => {
  const base = createInitialContext('run-schema');
  const invalid = {
    ...base,
    facts: {
      nested: { value: { secret: 'nope' }, status: 'verified', sourceEventId: 'evt', functionId: 'fn', pluginId: 'plugin', field: 'status' },
      oversized: { value: 'x'.repeat(257), status: 'verified', sourceEventId: 'evt', functionId: 'fn', pluginId: 'plugin', field: 'title' }
    }
  };
  assert.equal(validateContract('behaviorContext', invalid).ok, false);
});

test('插件显式声明的任意 bounded primitive fact 可以进入通用上下文', () => {
  const result = succeed('rank', {
    summary: '已查询排名',
    description: '这段说明不应自动成为事实'
  }, { rank: 3, queueName: 'support-a' });
  const output = result.output as Record<string, unknown>;
  const facts = output.facts as Record<string, unknown>;
  assert.equal(facts.rank, 3);
  assert.equal(facts.queueName, 'support-a');
  assert.equal(facts.description, undefined);
});

test('人工服务把排队位置作为显式事实而不是只写进自然语言摘要', async () => {
  const result = await humanTransferHandler({ operation: 'transfer', query: '请转人工', params: {} }, { pluginId: 'human-transfer-v1', functionId: 'human.transfer', runId: 'run-facts', correlationId: 'corr-facts' });
  const output = result.output as Record<string, unknown>;
  const facts = output.facts as Record<string, unknown>;
  assert.equal(facts.queuePosition, 3);
  assert.equal(facts.handoffId, 'handoff-20261018-001');
});

test('澄清选项通过事件投影进入 pending，非法重复选项不会污染旧状态', () => {
  const projector = new BehaviorContextProjector();
  projector.apply(actionEvent('evt-pending', 'action.completed', {
    functionId: 'human.transfer', pluginId: 'human-transfer-v1', resultStatus: 'succeeded',
    output: { accepted: true, operation: 'transfer', facts: { queuePosition: 3 } }
  }));
  const pendingEvent: EventEnvelope = {
    schemaVersion: SCHEMA_VERSIONS.event, eventId: 'evt-clarification', eventName: 'context.clarification.updated',
    occurredAt: '2026-10-19T00:00:01.000Z', runId: 'run-facts', correlationId: 'corr-facts',
    payload: { pending: { kind: 'selection', status: 'required', options: [{ key: '1', label: '第一项' }, { key: '2', label: '第二项' }] } }
  };
  projector.apply(pendingEvent);
  assert.deepEqual(projector.current().pending.options, [{ key: '1', label: '第一项' }, { key: '2', label: '第二项' }]);
  assert.throws(() => projector.apply({ ...pendingEvent, eventId: 'evt-invalid', payload: { pending: { kind: 'selection', status: 'required', options: [{ key: '1', label: '第一项' }, { key: '1', label: '重复项' }] } } }));
  assert.deepEqual(projector.current().pending.options, [{ key: '1', label: '第一项' }, { key: '2', label: '第二项' }]);
});

test('待解析引用通过澄清事件恢复且不改变执行权限', () => {
  const projector = new BehaviorContextProjector();
  const pendingEvent: EventEnvelope = {
    schemaVersion: SCHEMA_VERSIONS.event, eventId: 'evt-reference-pending', eventName: 'context.clarification.updated',
    occurredAt: '2026-10-19T00:00:02.000Z', runId: 'run-facts', correlationId: 'corr-facts',
    payload: {
      pending: { kind: 'input', status: 'required' },
      pendingReference: { text: 'relative', relation: 'previous', candidateRecordIds: ['record-a', 'record-b'] }
    }
  };
  projector.apply(pendingEvent);
  const context = projector.current();
  const restored = context as typeof context & { pendingReference?: unknown };
  assert.deepEqual(restored.pendingReference, { text: 'relative', relation: 'previous', candidateRecordIds: ['record-a', 'record-b'] });
  assert.equal(context.action.status, 'proposed');
  assert.equal(context.route.functionId, undefined);
});
