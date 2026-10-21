/**
 * 验证 Phase 4 的租户授权、能力不可扩展和插件版本回滚边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type WorkflowDefinition } from '@iar/contracts';
import { MockDecisionProvider } from '@iar/runtime';
import { PluginHost } from '@iar/plugins';
import { createServiceApi, type ServiceApiRequest } from '@iar/adapters-service';
import { TwoStageRouter } from '@iar/runtime';
import { LocalWorkflow } from '@iar/runtime';
import { facts, functionRule, pluginRule } from '../routing/rule-engine-fixtures.js';
import { loadBusinessManifest, pluginPackage } from '../contract/fixtures/plugin-package.js';

/** @returns 可安装的固定业务 Manifest @author lvdaxianer@yeah.net @date 2026-10-17 */
function manifest(overrides: Partial<BusinessPluginManifest> = {}): ReturnType<typeof pluginPackage> {
  return pluginPackage({ ...loadBusinessManifest(), ...overrides });
}

/** @returns 独立 tenant host 依赖 @author lvdaxianer@yeah.net @date 2026-10-17 */
function tenantHost(): { workflow: LocalWorkflow; pluginHost: PluginHost } {
  return { workflow: new LocalWorkflow(), pluginHost: new PluginHost() };
}

/** @param input - Service 请求覆盖项 @returns 版本化请求 @author lvdaxianer@yeah.net @date 2026-10-17 */
function serviceRequest(input: Partial<Pick<ServiceApiRequest, 'operation' | 'payload'>> & { tenantId?: string; actorId?: string } = {}): ServiceApiRequest {
  const tenantId = input.tenantId ?? 'tenant-a';
  return { protocolVersion: 'iar.service-api/v1', requestId: `security-${input.operation ?? 'inspect'}`, traceId: `trace-${tenantId}`, context: { tenantId, actorId: input.actorId ?? `actor-${tenantId}` }, operation: input.operation ?? 'plugin.inspect', payload: input.payload ?? { pluginId: 'dip-api-stop-v1' } };
}

test('tenant authorization rejects foreign tenant before host access', async () => {
  let createdHosts = 0;
  const api = createServiceApi({ authorize: ({ tenantId, actorId }) => actorId === `actor-${tenantId}`, hostFactory: () => { createdHosts += 1; return tenantHost(); } });
  const denied = await api.request(serviceRequest({ tenantId: 'tenant-b', actorId: 'actor-tenant-a' }));
  assert.equal(denied.error?.code, 'service.authorization_failed');
  assert.equal(createdHosts, 0);
  await api.close();
});

test('router rejects capability expansion from an Intent-shaped finite decision', () => {
  const host = new PluginHost();
  const installed = host.install(manifest({ pluginId: 'plugin-a' }));
  assert.equal(installed.ok, true);
  assert.equal(host.enable('plugin-a').ok, true);
  const chooseFirst = new MockDecisionProvider((request) => ({ schemaVersion: SCHEMA_VERSIONS.decision, decisionType: request.decisionType, decisionVersion: request.decisionVersion, status: 'choice', choice: request.candidates[0]?.candidateId, score: 0.99, reasonCode: 'intent_match', candidateIds: request.candidates.map((candidate) => candidate.candidateId) }));
  const expression = { condition: { field: 'semantic.intent', operator: 'equals' as const, value: 'service.stop' } };
  const result = new TwoStageRouter().route({ facts, tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod', functionRules: [functionRule('dip.service.stop', expression)], pluginRules: [pluginRule('plugin-a', expression, { requiredCapabilities: ['admin.escape'] })], pluginHost: host, functionProvider: chooseFirst, pluginProvider: chooseFirst, authorizePlugin: () => true });
  assert.notEqual(result.status, 'matched');
  assert.equal(result.pluginId, undefined);
});

test('failed plugin upgrade restores the previous fixed version and retains history', () => {
  const host = new PluginHost();
  const oldManifest = manifest({ pluginId: 'plugin-a', version: '1.0.0' });
  assert.equal(host.install(oldManifest).ok, true);
  assert.equal(host.enable('plugin-a').ok, true);
  assert.equal(host.disable('plugin-a').ok, true);
  assert.equal(host.unload('plugin-a').ok, true);
  assert.equal(host.install({ ...oldManifest, manifest: { ...oldManifest.manifest, apiVersion: 'iar.dev/v0' } } as unknown).ok, false);
  assert.equal(host.install(oldManifest).ok, true);
  assert.equal(host.enable('plugin-a').ok, true);
  assert.equal(host.get('plugin-a')?.manifest.version, '1.0.0');
  assert.ok(host.history('plugin-a').some((event) => event.eventName === 'plugin.unloaded'));
});
