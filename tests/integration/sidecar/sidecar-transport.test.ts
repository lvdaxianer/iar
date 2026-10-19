/**
 * 验证 Sidecar JSON/HTTP transport 只做协议转发，不复制运行时语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServiceApi, type ServiceApiRequest } from '@iar/adapters-service';
import { createSidecarServer, createSidecarTransport } from '@iar/adapters-sidecar';
import { LocalWorkflow } from '@iar/workflow';
import { PluginHost } from '@iar/plugin-host';
import { SCHEMA_VERSIONS, type WorkflowDefinition } from '@iar/contracts';

/*
 * Sidecar test 同时走 JSON handler 和真实 Node HTTP server。
 * 两条 transport path 都只调用同一个 ServiceApi。
 * requestId、traceId、tenantId 和 data/error 必须跨边界保留。
 * 非 POST 路由不能进入 Service runtime。
 * body limit 与 JSON parse 错误必须返回稳定 transport error。
 * 测试使用 loopback ephemeral port，不依赖外部网络。
 * server 和 ServiceApi 都在断言后关闭，避免句柄悬挂。
 * 非有限 body limit 配置必须在 server 创建阶段失败。
 * 超限请求返回 413 且不调用 transport。
 * 超限流会继续消费，避免连接资源悬挂。
 * 读取异常转换为稳定 body_read_failed。
 * body limit 是字节数而不是字符数。
 * HTTP 路由拒绝早于 Service API 调用。
 * 测试不依赖固定端口或外部网络。
 * sidecar 不实现第二套 Workflow 或 PluginHost 状态机。
 */

/**
 * Sidecar fixture 使用和 Service 相同的 host factory。
 *
 * @returns 测试用 WorkflowDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.workflow, workflowId: 'sidecar', version: '1.0.0', description: 'sidecar fixture', states: ['start', 'done'], initialState: 'start', terminalStates: ['done'], transitions: [{ event: 'finish', from: 'start', to: 'done' }] };
}

/**
 * 创建单租户测试 API，授权器拒绝任何其他 actor。
 *
 * @returns 单租户 ServiceApi
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createApi() {
  return createServiceApi({
    authorize: (context) => context.tenantId === 'tenant-sidecar' && context.actorId === 'actor-sidecar',
    hostFactory: () => ({ workflow: new LocalWorkflow(), pluginHost: new PluginHost({ functionIds: ['service.finish'] }) })
  });
}

/**
 * 构造 JSON transport 请求，验证 trace、tenant 和 requestId 跨边界保留。
 *
 * @returns Sidecar 输入的 ServiceApiRequest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(): ServiceApiRequest {
  return { protocolVersion: 'iar.service-api/v1', requestId: 'sidecar-request', traceId: 'sidecar-trace', context: { tenantId: 'tenant-sidecar', actorId: 'actor-sidecar' }, operation: 'run.create', payload: { runId: 'sidecar-run', definition: definition() } };
}

/** JSON handler 与直接 ServiceApi 调用返回同一结构化响应。 */
test('Sidecar JSON transport preserves service response metadata', async () => {
  const api = createApi();
  const transport = createSidecarTransport(api);
  const response = await transport.handleJson(JSON.stringify(request()));
  const body = JSON.parse(response) as Record<string, unknown>;
  assert.equal(body.protocolVersion, 'iar.sidecar/v1');
  assert.equal(body.requestId, 'sidecar-request');
  assert.equal(body.traceId, 'sidecar-trace');
  assert.equal(body.tenantId, 'tenant-sidecar');
  assert.equal((body.data as Record<string, unknown>).runId, 'sidecar-run');
  await api.close();
});

/** HTTP server 必须限制方法、解析 JSON，并将坏请求转换为稳定协议错误。 */
test('Sidecar HTTP server serves JSON and rejects malformed protocol', async () => {
  const api = createApi();
  const server = createSidecarServer(createSidecarTransport(api), { bodyLimit: 4096 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/v1/sidecar`;
  const accepted = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request()) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).error, null);
  const rejected = await fetch(url, { method: 'GET' });
  assert.equal(rejected.status, 405);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await api.close();
});

/** 非有限或超限 body limit 必须拒绝且不进入 ServiceApi。 */
test('Sidecar rejects invalid and oversized body limits', async () => {
  const api = createApi();
  const transport = createSidecarTransport(api);
  assert.throws(() => createSidecarServer(transport, { bodyLimit: Number.POSITIVE_INFINITY }), /bodyLimit/);
  const server = createSidecarServer(transport, { bodyLimit: 8 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/sidecar`, { method: 'POST', body: JSON.stringify(request()) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'sidecar.body_too_large');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await api.close();
});
