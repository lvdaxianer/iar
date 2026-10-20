/**
 * 验证结构化观测、敏感字段脱敏和 system logging fail-open 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePluginManifest } from '@iar/contracts';
import { createSystemLoggingPlugin, installSystemLoggingPlugin, SYSTEM_LOGGING_PLUGIN_MANIFEST, SYSTEM_LOGGING_SUBSCRIPTIONS } from '@iar/observability';
import { ObservabilityRecorder, type ObservabilityRecord } from '@iar/observability';
import { SubscriptionDispatcher, SubscriptionRegistry, type DispatchEvent } from '@iar/subscriptions';

const event = (payload: Record<string, unknown>): DispatchEvent => ({ eventId: 'event-1', eventName: 'input.received', runId: 'run-1', correlationId: 'trace-1', payload: payload as never });

test('recorder emits correlated redacted records for log, trace, metric and audit', async () => {
  const records: ObservabilityRecord[] = [];
  const recorder = new ObservabilityRecorder({ sink: { write: (record) => { records.push(record); } }, clock: () => '2026-10-17T00:00:00.000Z', sensitivePaths: ['custom.secretSlot'] });
  await recorder.log({ level: 'info', traceId: 'trace-1', runId: 'run-1', eventName: 'input.received', fields: { route: '/v1/runs', rawUserInput: 'private-input', custom: { secretSlot: 'configured-secret' } } });
  await recorder.trace({ traceId: 'trace-1', runId: 'run-1', eventName: 'action.started', fields: { pluginVersion: '1.0.0' } });
  await recorder.metric({ traceId: 'trace-1', runId: 'run-1', eventName: 'action.completed', fields: { durationMs: 4, resultCode: 'ok' }, name: 'action.duration', value: 4 });
  await recorder.audit({ traceId: 'trace-1', runId: 'run-1', eventName: 'policy.evaluated', fields: { policyDecision: 'allow', authorization: 'Bearer authorization-secret', apiKey: 'api-key-secret' } });
  assert.equal(records.length, 4);
  assert.equal(JSON.stringify(records).includes('private-input'), false);
  assert.equal(JSON.stringify(records).includes('configured-secret'), false);
  assert.equal(JSON.stringify(records).includes('authorization-secret'), false);
  assert.equal(JSON.stringify(records).includes('api-key-secret'), false);
  assert.deepEqual(records.map((record) => [record.traceId, record.runId]), [['trace-1', 'run-1'], ['trace-1', 'run-1'], ['trace-1', 'run-1'], ['trace-1', 'run-1']]);
});

test('recorder snapshots sanitized fields and bounds metadata without mutating input', async () => {
  const recorder = new ObservabilityRecorder({ maxMetadataBytes: 120 });
  const fields = { route: '/v1/runs', rawPrompt: 'prompt-secret', nested: { token: 'token-secret' } };
  await recorder.log({ level: 'debug', traceId: 'trace-1', runId: 'run-1', eventName: 'run.created', fields });
  fields.rawPrompt = 'mutated';
  assert.equal(JSON.stringify(recorder.snapshot()).includes('prompt-secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('token-secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('mutated'), false);
});

test('system logging plugin is runtime-scoped and never projects raw payload', async () => {
  const recorder = new ObservabilityRecorder();
  const plugin = createSystemLoggingPlugin(recorder);
  assert.equal(validatePluginManifest(plugin.manifest).ok, true);
  assert.equal(plugin.manifest.pluginKind, 'system');
  assert.equal(plugin.manifest.scope, 'runtime');
  assert.equal(plugin.subscription.failurePolicy, 'fail-open');
  assert.equal(Object.isFrozen(SYSTEM_LOGGING_PLUGIN_MANIFEST), true);
  assert.equal(Object.isFrozen(SYSTEM_LOGGING_SUBSCRIPTIONS), true);
  const result = await plugin.handler(event({ rawPrompt: 'prompt-secret', rawUserInput: 'input-secret', apiKey: 'key-secret', route: '/v1/runs', pluginId: 'plugin-a' }), plugin.subscription, new AbortController().signal);
  assert.deepEqual(result, {});
  assert.equal(JSON.stringify(recorder.snapshot()).includes('prompt-secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('input-secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('key-secret'), false);
  assert.equal(JSON.stringify(recorder.snapshot()).includes('/v1/runs'), true);
});

test('observer sink failure is counted and does not reject system handler', async () => {
  const recorder = new ObservabilityRecorder({ sink: { write: async () => { throw new Error('sink unavailable'); } } });
  const plugin = createSystemLoggingPlugin(recorder);
  const result = await plugin.handler(event({ rawUserInput: 'private-input' }), plugin.subscription, new AbortController().signal);
  assert.deepEqual(result, {});
  assert.equal(recorder.observerFailureCount, 1);
  assert.equal(recorder.snapshot()[0]?.traceId, 'trace-1');
  assert.equal(recorder.snapshot()[1]?.eventName, 'observability.observer_failed');
  assert.equal((recorder.snapshot()[1]?.fields.sourceEventName), 'input.received');
  assert.equal(recorder.snapshot()[1]?.runId, 'run-1');
});

test('dispatcher keeps business event allowed when logging observer fails open', async () => {
  const recorder = new ObservabilityRecorder({ sink: { write: () => { throw new Error('sink unavailable'); } } });
  const registry = new SubscriptionRegistry();
  const dispatcher = new SubscriptionDispatcher(registry);
  const plugin = installSystemLoggingPlugin(registry, dispatcher, recorder);
  const report = await dispatcher.publish(event({ rawPrompt: 'private-prompt', rawUserInput: 'private-input', authorization: 'Bearer secret' }));
  assert.equal(plugin.manifest.pluginKind, 'system');
  assert.equal(report.allowed, true);
  assert.equal(report.blocked, false);
  assert.equal(report.executions[0]?.succeeded, true);
  assert.equal(recorder.observerFailureCount, 1);
});
