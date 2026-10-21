/**
 * 验证 Service、Sidecar 和隔离 executor 的跨边界安全语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type SystemPluginManifest } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { createWorkerExecutor, type ExecutorRequest } from '@iar/adapters-executors';
import { createServiceApi, type ServiceApiRequest } from '@iar/adapters-service';
import { createSidecarTransport } from '@iar/adapters-sidecar';
import { LocalWorkflow } from '@iar/runtime';

/**
 * Service API 传输 JSON，只管理可序列化的系统 Plugin 生命周期；业务 Plugin
 * 的 Handler 通过 @iar/plugin 和 @iar/agent 在本地进程注册。
 *
 * @returns 固定系统 Plugin Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function manifest(): SystemPluginManifest {
  return {
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId: 'iar.system.audit-v1',
    pluginKind: 'system',
    scope: 'runtime',
    version: '1.0.0',
    description: 'Service security integration fixture',
    capabilities: ['observability'],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    lifecycle: { entrypoint: 'builtin:iar.system.audit' },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['observability'] },
    dependencies: []
  };
}

/** @param input - Service 请求覆盖项 @returns 版本化请求 @author lvdaxianer@yeah.net @date 2026-10-17 */
function serviceRequest(input: Partial<Pick<ServiceApiRequest, 'operation' | 'payload'>> & { tenantId?: string; actorId?: string } = {}): ServiceApiRequest {
  const tenantId = input.tenantId ?? 'tenant-a';
  return { protocolVersion: 'iar.service-api/v1', requestId: `integration-${input.operation ?? 'inspect'}`, traceId: `trace-${tenantId}`, context: { tenantId, actorId: input.actorId ?? `actor-${tenantId}` }, operation: input.operation ?? 'plugin.inspect', payload: input.payload ?? { pluginId: 'iar.system.audit-v1' } };
}

/** @returns 每 tenant 隔离的 Service API @author lvdaxianer@yeah.net @date 2026-10-17 */
function createTenantServiceApi() {
  const hosts = new Map<string, { workflow: LocalWorkflow; pluginHost: PluginHost }>();
  return createServiceApi({ authorize: ({ tenantId, actorId }) => actorId === `actor-${tenantId}`, hostFactory: (tenantId) => { const current = hosts.get(tenantId); if (current) return current; const next = { workflow: new LocalWorkflow(), pluginHost: new PluginHost() }; hosts.set(tenantId, next); return next; } });
}

/** @returns 合法 executor 请求 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validRequest(): ExecutorRequest {
  return { protocolVersion: 'iar.executor/v1', requestId: 'a-1', traceId: 'trace-a', tenantId: 'tenant-a', pluginId: 'plugin-a', pluginVersion: '1.0.0', capabilities: ['plugin.execute'], credentialRefs: [], input: {}, timeoutMs: 50 };
}

test('service install/inspect stays tenant scoped and sidecar preserves safe errors', async () => {
  const api = createTenantServiceApi();
  const installed = await api.request(serviceRequest({ operation: 'plugin.install', payload: { manifest: manifest() } }));
  assert.equal(installed.error, null);
  const foreign = await api.request(serviceRequest({ tenantId: 'tenant-b', actorId: 'actor-tenant-b', operation: 'plugin.inspect', payload: { pluginId: 'dip-api-stop-v1' } }));
  assert.equal(foreign.error?.code, 'plugin.unavailable');
  const sidecar = createSidecarTransport(api);
  const malformed = JSON.parse(await sidecar.handleJson('{"protocolVersion":"iar.sidecar/v0","payload":{"apiKey":"secret"}}')) as { error: { code: string }; protocolVersion: string };
  assert.equal(malformed.error.code, 'service.invalid_request');
  assert.equal(malformed.protocolVersion, 'iar.sidecar/v1');
  assert.equal(JSON.stringify(malformed).includes('secret'), false);
  await api.close();
});

test('executor instances cannot cancel another instance active request', async () => {
  const first = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const second = createWorkerExecutor({ version: '1.0.0', maxTimeoutMs: 100 });
  const pending = first.execute(validRequest(), async () => new Promise(() => undefined));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(second.cancel('a-1'), false);
  assert.equal(second.activeRequestCount(), 0);
  await first.close();
  const response = await pending;
  assert.equal(response.error?.code, 'executor.cancelled');
  await second.close();
});
