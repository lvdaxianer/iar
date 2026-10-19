/**
 * 验证成功 Action 输出只把契约允许的有限字段投影为可信事实。
 * 失败事件、未公开字段和其他会话不能污染事实集合。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateContract, type EventEnvelope } from '../../packages/contracts/src/index.js';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from '../../packages/runtime/src/index.js';
import { jobMonitorHandler } from '../../examples/agent-sandbox/src/functions/job-monitor.js';
import { ticketCreateHandler } from '../../examples/agent-sandbox/src/functions/ticket-create.js';

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
  assert.equal(context.facts?.['ticket.create.ticketId']?.value, 'ticket-001');
  assert.equal(context.facts?.['ticket.create.receipt']?.sourceEventId, 'evt-ticket-created');
  assert.equal(context.facts?.['ticket.create.receipt']?.status, 'verified');
  assert.equal(context.facts?.['ticket.create.secretToken'], undefined);
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
  const facts = projector.current().facts ?? {};
  assert.equal(facts['job.monitor.jobName']?.value, '订单汇总日报');
  assert.equal(facts['ticket.create.ticketId'], undefined);
});

test('每个投影器只维护自己的事实集合', () => {
  const first = new BehaviorContextProjector(createInitialContext('run-first'));
  const second = new BehaviorContextProjector(createInitialContext('run-second'));
  first.apply(actionEvent('evt-first', 'action.completed', {
    functionId: 'ticket.create', pluginId: 'ticket-create-v1', resultStatus: 'succeeded',
    output: { accepted: true, operation: 'create', ticketId: 'ticket-first', facts: { operation: 'create', ticketId: 'ticket-first' } }
  }));
  assert.equal(first.current().facts?.['ticket.create.ticketId']?.value, 'ticket-first');
  assert.equal(second.current().facts?.['ticket.create.ticketId'], undefined);
});

test('真实多业务 Handler 只把显式事实信封投影到上下文', async () => {
  const result = await jobMonitorHandler({ operation: 'status', query: '订单汇总日报', params: {} }, { pluginId: 'job-monitor-v1', functionId: 'job.monitor', runId: 'run-facts', correlationId: 'corr-facts' });
  const projector = new BehaviorContextProjector();
  projector.apply(actionEvent('evt-job-status', 'action.completed', {
    functionId: 'job.monitor', pluginId: 'job-monitor-v1', resultStatus: 'succeeded', output: result.output
  }));
  const facts = projector.current().facts ?? {};
  assert.equal(facts['job.monitor.jobName']?.value, '订单汇总日报');
  assert.equal(facts['job.monitor.status']?.value, 'success');
  assert.equal(facts['job.monitor.job'], undefined);
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
