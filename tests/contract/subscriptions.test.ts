/**
 * 验证内部 before Hook 和异步 StateEvent 订阅调度。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SubscriptionDispatcher,
  SubscriptionRegistry,
  type DispatchEvent,
  type HookHandler,
  type HookSubscription
} from '../../packages/subscriptions/src/index.js';

const event: DispatchEvent = {
  eventId: 'evt-action-1',
  eventName: 'action.before',
  runId: 'run-1',
  correlationId: 'corr-1',
  payload: { tenantId: 'tenant_demo', riskLevel: 'high', functionId: 'dip.service.stop' }
};

function subscription(overrides: Partial<HookSubscription>): HookSubscription {
  return {
    subscriptionId: 'permission-check',
    event: 'action.before',
    delivery: 'sync',
    priority: 1000,
    failurePolicy: 'fail-closed',
    handler: { type: 'callback', ref: 'permission-handler' },
    ...overrides
  };
}

// 高优先级权限拒绝必须阻断低优先级审计 Hook。
test('before hooks run by priority and deny blocks later handlers', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'deny-first', priority: 1000, handler: { type: 'callback', ref: 'deny' } }));
  registry.register(subscription({ subscriptionId: 'audit-second', priority: 100, handler: { type: 'callback', ref: 'audit' } }));
  const dispatcher = new SubscriptionDispatcher(registry);
  const calls: string[] = [];
  dispatcher.registerHandler('deny', async () => { calls.push('deny'); return { decision: 'deny', reasonCode: 'permission.denied' }; });
  dispatcher.registerHandler('audit', async () => { calls.push('audit'); return { decision: 'allow' }; });
  const result = await dispatcher.runBefore(event);
  assert.equal(result.allowed, false);
  assert.deepEqual(calls, ['deny']);
});

// 异步 observer 失败不能阻断主流程，重复事件只能调用一次 Handler。
test('async fail-open observer does not block and duplicate delivery is idempotent', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'audit', event: 'action.failed', delivery: 'async', failurePolicy: 'fail-open', handler: { type: 'callback', ref: 'observer' } }));
  const dispatcher = new SubscriptionDispatcher(registry);
  let attempts = 0;
  const handler: HookHandler = async () => { attempts += 1; throw new Error('observer unavailable'); };
  dispatcher.registerHandler('observer', handler);
  const failed = { ...event, eventName: 'action.failed' };
  dispatcher.enqueue(failed);
  dispatcher.enqueue(failed);
  assert.equal(attempts, 0);
  const reports = await dispatcher.drain();
  assert.equal(reports.length, 2);
  assert.equal(attempts, 1);
  assert.equal(reports[0]?.blocked, false);
});

// 过滤、失败重试和递归上限共同限制 StateEvent 投递边界。
test('filter, retry, timeout and recursion depth are enforced', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'filtered', event: 'action.failed', delivery: 'async', filter: { functionId: { equals: 'ticket.create' } }, retryPolicy: { maxRetries: 1, backoffMs: 0 }, handler: { type: 'callback', ref: 'retry' } }));
  const dispatcher = new SubscriptionDispatcher(registry, { maxRecursionDepth: 1 });
  let attempts = 0;
  dispatcher.registerHandler('retry', async () => { attempts += 1; if (attempts === 1) throw new Error('temporary'); return { decision: 'allow' }; });
  dispatcher.enqueue({ ...event, eventName: 'action.failed' });
  assert.deepEqual(await dispatcher.drain(), []);
  dispatcher.enqueue({ ...event, eventName: 'action.failed', payload: { functionId: 'ticket.create' } });
  const reports = await dispatcher.drain();
  assert.equal(reports[0]?.executions[0]?.succeeded, true);
  assert.equal(attempts, 2);
  const rejected = await dispatcher.publish({ ...event, eventName: 'action.failed', recursionDepth: 2 });
  assert.equal(rejected.rejected, true);
});

// Runtime 不允许未知事件绕过事件字典进入 Handler。
test('unknown events are rejected before any handler is invoked', async () => {
  const registry = new SubscriptionRegistry();
  const dispatcher = new SubscriptionDispatcher(registry);
  let invoked = false;
  dispatcher.registerHandler('observer', async () => {
    invoked = true;
    return { decision: 'allow' };
  });
  const rejected = await dispatcher.publish({ ...event, eventName: 'unknown.event' });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.allowed, false);
  assert.equal(invoked, false);
});

// 合法通配订阅只能覆盖事件字典中的子事件。
test('known wildcard subscriptions do not accept unknown event children', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({
    subscriptionId: 'run-observer',
    event: 'run.*',
    delivery: 'async',
    failurePolicy: 'fail-open',
    handler: { type: 'callback', ref: 'observer' }
  }));
  const dispatcher = new SubscriptionDispatcher(registry);
  let invoked = false;
  dispatcher.registerHandler('observer', async () => {
    invoked = true;
    return { decision: 'allow' };
  });
  const rejected = await dispatcher.publish({ ...event, eventName: 'run.unknown' });
  assert.equal(rejected.rejected, true);
  assert.equal(invoked, false);
});

// 权限 Hook 超时必须 fail-closed，并保留链路关联字段。
test('fail-closed timeout blocks while preserving correlation evidence', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({
    subscriptionId: 'permission-timeout',
    timeoutMs: 1,
    retryPolicy: { maxRetries: 1, backoffMs: 0 },
    handler: { type: 'callback', ref: 'slow-permission' }
  }));
  const dispatcher = new SubscriptionDispatcher(registry);
  let attempts = 0;
  let aborted = false;
  dispatcher.registerHandler('slow-permission', async (received, _subscription, signal) => {
    attempts += 1;
    assert.equal(received.correlationId, event.correlationId);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { decision: 'allow' };
  });
  const result = await dispatcher.runBefore(event);
  assert.equal(result.allowed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.executions[0]?.attempts, 1);
  assert.equal(attempts, 1);
  assert.equal(aborted, true);
  assert.equal(result.executions[0]?.correlationId, event.correlationId);
});

// 禁用订阅不执行，相同优先级按订阅标识保持确定性顺序。
test('disabled subscriptions are skipped and equal priorities are deterministic', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'z-audit', priority: 10, handler: { type: 'callback', ref: 'z' } }));
  registry.register(subscription({ subscriptionId: 'a-audit', priority: 10, handler: { type: 'callback', ref: 'a' } }));
  registry.register(subscription({ subscriptionId: 'disabled-audit', priority: 100, enabled: false, handler: { type: 'callback', ref: 'disabled' } }));
  const dispatcher = new SubscriptionDispatcher(registry);
  const calls: string[] = [];
  dispatcher.registerHandler('a', async () => { calls.push('a'); return { decision: 'allow' }; });
  dispatcher.registerHandler('z', async () => { calls.push('z'); return { decision: 'allow' }; });
  dispatcher.registerHandler('disabled', async () => { calls.push('disabled'); return { decision: 'allow' }; });
  const result = await dispatcher.runBefore(event);
  assert.deepEqual(calls, ['a', 'z']);
  assert.equal(result.executions.length, 2);
});

// 异步 deny 只作为观察结果，不改变发布方的主流程许可。
test('async deny remains an observation and does not block the publisher', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({
    subscriptionId: 'observer-deny',
    event: 'action.failed',
    delivery: 'async',
    failurePolicy: 'fail-open',
    handler: { type: 'callback', ref: 'observer-deny' }
  }));
  const dispatcher = new SubscriptionDispatcher(registry);
  dispatcher.registerHandler('observer-deny', async () => ({ decision: 'deny', reasonCode: 'observer.only' }));
  const result = await dispatcher.publish({ ...event, eventName: 'action.failed' });
  assert.equal(result.allowed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.executions[0]?.result?.decision, 'deny');
});

// 失败幂等命中必须重放失败状态，不能伪装成成功。
test('duplicate delivery replays a failed execution instead of reporting success', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({
    subscriptionId: 'failed-observer',
    event: 'action.failed',
    delivery: 'async',
    failurePolicy: 'fail-open',
    handler: { type: 'callback', ref: 'failed-observer' }
  }));
  const dispatcher = new SubscriptionDispatcher(registry);
  let attempts = 0;
  dispatcher.registerHandler('failed-observer', async () => {
    attempts += 1;
    throw new Error('unavailable');
  });
  const failed = { ...event, eventName: 'action.failed' };
  const first = await dispatcher.publish(failed);
  const second = await dispatcher.publish(failed);
  assert.equal(attempts, 1);
  assert.equal(first.executions[0]?.succeeded, false);
  assert.equal(second.executions[0]?.succeeded, false);
  assert.equal(second.executions[0]?.skipped, true);
});

// Handler 的异常文本和幂等容量状态都必须映射为稳定错误码。
test('handler errors are redacted and idempotency capacity is explicit', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'capacity', event: 'action.failed', delivery: 'async', handler: { type: 'callback', ref: 'capacity' } }));
  const dispatcher = new SubscriptionDispatcher(registry, { maxIdempotencyEntries: 2 });
  dispatcher.registerHandler('capacity', async (received) => {
    if (received.eventId === 'evt-secret') throw new Error('subscription.secret-token');
    if (received.eventId === 'evt-forged') throw new Error('subscription.invalid_patch');
    return { decision: 'allow' };
  });
  const secret = await dispatcher.publish({ ...event, eventId: 'evt-secret', eventName: 'action.failed' });
  const forged = await dispatcher.publish({ ...event, eventId: 'evt-forged', eventName: 'action.failed' });
  const full = await dispatcher.publish({ ...event, eventId: 'evt-capacity', eventName: 'action.failed' });
  assert.equal(secret.executions[0]?.errorCode, 'subscription.handler_failed');
  assert.equal(forged.executions[0]?.errorCode, 'subscription.handler_failed');
  assert.equal(full.executions[0]?.errorCode, 'subscription.idempotency_capacity');
});

// 入队返回稳定拒绝原因，派生事件自动传播递归和关联元数据。
test('enqueue reports unknown events and derived events advance recursion metadata', async () => {
  const registry = new SubscriptionRegistry();
  const dispatcher = new SubscriptionDispatcher(registry, { maxRecursionDepth: 1 });
  const rejected = dispatcher.enqueue({ ...event, eventName: 'unknown.event' });
  assert.deepEqual(rejected, { accepted: false, rejected: true, reason: 'unknown_event' });
  const derived = dispatcher.deriveEvent(event, { eventId: 'evt-derived', eventName: 'action.failed', payload: {} });
  assert.equal(derived.causationId, event.eventId);
  assert.equal(derived.correlationId, event.correlationId);
  assert.equal(derived.recursionDepth, 1);
});

// 在途任务和队列容量都必须参与幂等与背压边界计算。
test('in-flight idempotency survives cache pressure and queue capacity rejects overflow', async () => {
  const registry = new SubscriptionRegistry();
  registry.register(subscription({ subscriptionId: 'slow', event: 'action.failed', delivery: 'async', handler: { type: 'callback', ref: 'slow' } }));
  const dispatcher = new SubscriptionDispatcher(registry, { maxQueueSize: 1, maxIdempotencyEntries: 1 });
  const calls = new Map<string, number>();
  dispatcher.registerHandler('slow', async (received) => {
    calls.set(received.eventId, (calls.get(received.eventId) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { decision: 'allow' };
  });
  const first = { ...event, eventId: 'evt-queue-1', eventName: 'action.failed' };
  const second = { ...event, eventId: 'evt-queue-2', eventName: 'action.failed' };
  assert.deepEqual(dispatcher.enqueue(first), { accepted: true, rejected: false });
  assert.deepEqual(dispatcher.enqueue(second), { accepted: false, rejected: true, reason: 'queue_full' });
  const firstPublish = dispatcher.publish(first);
  const duplicateInFlight = dispatcher.publish(first);
  await dispatcher.drain();
  await firstPublish;
  const duplicate = await duplicateInFlight;
  assert.equal(calls.get(first.eventId), 1);
  assert.equal(duplicate.executions[0]?.skipped, true);

  const retained = new SubscriptionDispatcher(registry, { maxQueueSize: 1 });
  retained.registerHandler('slow', async () => ({ decision: 'allow' }));
  assert.deepEqual(retained.enqueue(first), { accepted: true, rejected: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(retained.enqueue(second), { accepted: false, rejected: true, reason: 'queue_full' });
  await retained.drain();
});

// 外部动态输入必须返回稳定拒绝原因，而不是抛出原生 TypeError。
test('invalid event objects and non-finite JSON numbers are rejected', async () => {
  const dispatcher = new SubscriptionDispatcher(new SubscriptionRegistry());
  const invalidObject = await dispatcher.publish(null as unknown as DispatchEvent);
  const invalidNumber = await dispatcher.publish({ ...event, payload: Number.NaN as never });
  const cyclic = {} as { self?: unknown };
  cyclic.self = cyclic;
  const invalidCycle = await dispatcher.publish({ ...event, payload: cyclic as never });
  const invalidCausation = await dispatcher.publish({ ...event, causationId: 42 as never });
  const registry = new SubscriptionRegistry();
  assert.throws(() => registry.register(null as never), /订阅定义必须是对象/);
  assert.throws(() => registry.register(subscription({ filter: { riskLevel: { equals: Number.NaN as never } } })), /JSON 值/);
  assert.equal(invalidObject.reason, 'invalid_event');
  assert.equal(invalidNumber.reason, 'invalid_event');
  assert.equal(invalidCycle.reason, 'invalid_event');
  assert.equal(invalidCausation.reason, 'invalid_event');
});
