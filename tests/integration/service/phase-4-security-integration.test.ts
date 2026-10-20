/**
 * 验证 Service、Sidecar 和隔离 executor 的跨边界安全语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { FunctionPluginManifest } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { createWorkerExecutor, type ExecutorRequest } from '@iar/adapters-executors';
import { createServiceApi, type ServiceApiRequest } from '@iar/adapters-service';
import { createSidecarTransport } from '@iar/adapters-sidecar';
import { LocalWorkflow } from '@iar/workflow';

/** @returns 固定业务插件 Manifest @author lvdaxianer@yeah.net @date 2026-10-17 */
function manifest(): FunctionPluginManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests/contract/fixtures/valid-plugin-manifest.json'), 'utf8')) as FunctionPluginManifest;
}

/** @param input - Service 请求覆盖项 @returns 版本化请求 @author lvdaxianer@yeah.net @date 2026-10-17 */
function serviceRequest(input: Partial<Pick<ServiceApiRequest, 'operation' | 'payload'>> & { tenantId?: string; actorId?: string } = {}): ServiceApiRequest {
  const tenantId = input.tenantId ?? 'tenant-a';
  return { protocolVersion: 'iar.service-api/v1', requestId: `integration-${input.operation ?? 'inspect'}`, traceId: `trace-${tenantId}`, context: { tenantId, actorId: input.actorId ?? `actor-${tenantId}` }, operation: input.operation ?? 'plugin.inspect', payload: input.payload ?? { pluginId: 'dip-api-stop-v1' } };
}

/** @returns 每 tenant 隔离的 Service API @author lvdaxianer@yeah.net @date 2026-10-17 */
function createTenantServiceApi() {
  const hosts = new Map<string, { workflow: LocalWorkflow; pluginHost: PluginHost }>();
  return createServiceApi({ authorize: ({ tenantId, actorId }) => actorId === `actor-${tenantId}`, hostFactory: (tenantId) => { const current = hosts.get(tenantId); if (current) return current; const next = { workflow: new LocalWorkflow(), pluginHost: new PluginHost({ functionIds: ['dip.service.stop'] }) }; hosts.set(tenantId, next); return next; } });
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
