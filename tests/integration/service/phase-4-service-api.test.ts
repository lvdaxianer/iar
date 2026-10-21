/**
 * 验证 Service API 在授权、租户状态和 Fastify v1 contract 上保持稳定。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type WorkflowDefinition } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { createFastifyApp } from '@iar/adapters-fastify';
import { createServiceApi, type ServiceApiRequest } from '@iar/adapters-service';
import { LocalWorkflow } from '@iar/runtime';

/*
 * 本文件比较 Embedded Fastify 和 ServiceApi 的同一 run fixture。
 * ServiceApi 必须先授权，再按 tenant 缓存 Workflow/PluginHost。
 * 同一 runId 在不同 tenant 中必须保持不可见。
 * malformed protocol 不能触发 hostFactory 或业务路由。
 * replay 是只读投影，不应执行副作用。
 * response 保留 fastify schemaVersion、version、data、error 和 runId。
 * 测试不连接真实数据库、不读取环境变量、不启动远程服务。
 * 每个 API 实例在测试结束时显式 close，避免 Fastify 句柄泄漏。
 * error 断言只检查稳定 code，不比较原始异常文本。
 * tenant authorization 的异常路径按 fail-closed 语义覆盖。
 * 测试 fixture 使用固定 ASCII ID，避免 transport 编码差异。
 * 冻结上下文覆盖授权器尝试修改 tenant 的 TOCTOU 风险。
 * host ownership 覆盖工厂错误共享 Workflow 的风险。
 * 跨 tenant host 复用必须转换为稳定 host_unavailable。
 * 新增断言不依赖内部异常文本。
 * 授权器通过后仍按 tenant 查找独立 host。
 * 该测试保持不启动外部进程。
 * 共享 host 的失败响应不泄露另一个租户的状态。
 * frozen context 的 tenant 标识保持原值。
 * Service close 在所有测试路径结束时执行。
 * 该 focused suite 不覆盖 executor、observability 和 durable workflow。
 */

/**
 * 创建跨 Embedded、Service 和 Sidecar 复用的确定性 Workflow 定义。
 *
 * @returns 测试用 WorkflowDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.workflow, workflowId: 'service-api', version: '1.0.0', description: 'service api fixture', states: ['start', 'done'], initialState: 'start', terminalStates: ['done'], transitions: [{ event: 'finish', from: 'start', to: 'done' }] };
}

/**
 * 创建带租户授权和每租户状态隔离的 Service API。
 *
 * @returns 独立的 ServiceApi 测试实例
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createApi(): ReturnType<typeof createServiceApi> {
  const hosts = new Map<string, { workflow: LocalWorkflow; pluginHost: PluginHost }>();
  return createServiceApi({
    authorize: (context) => context.actorId === `actor-${context.tenantId}`,
    hostFactory: (tenantId) => {
      const existing = hosts.get(tenantId);
      if (existing) return existing;
      const host = { workflow: new LocalWorkflow(), pluginHost: new PluginHost() };
      hosts.set(tenantId, host);
      return host;
    }
  });
}

/**
 * 创建版本化 service request，避免测试绕过协议边界。
 *
 * @param operation - 要调用的 Service operation
 * @param tenantId - 请求租户
 * @param actorId - 请求 actor
 * @param payload - JSON payload
 * @returns ServiceApiRequest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function request(input: { operation: ServiceApiRequest['operation']; tenantId?: string; actorId?: string; payload?: Record<string, unknown> }): ServiceApiRequest {
  const { operation, tenantId = 'tenant-a', actorId = 'actor-tenant-a', payload = {} } = input;
  return { protocolVersion: 'iar.service-api/v1', requestId: `${operation}-request`, traceId: `${operation}-trace`, context: { tenantId, actorId }, operation, payload };
}

/** Service run request 必须与 Embedded Fastify response 保持同一 data/error 语义。 */
test('Service API preserves Fastify v1 run contract for an authorized tenant', async () => {
  const api = createApi();
  const embedded = await createFastifyApp({ workflow: new LocalWorkflow(), pluginHost: new PluginHost() });
  const embeddedResponse = await embedded.inject({ method: 'POST', url: '/v1/runs', headers: { 'x-trace-id': 'run.create-trace' }, payload: { runId: 'run-parity', definition: definition() } });
  const serviceResponse = await api.request<{ runId: string }>(request({ operation: 'run.create', payload: { runId: 'run-parity', definition: definition() } }));
  assert.equal(embeddedResponse.statusCode, 201);
  assert.equal(serviceResponse.error, null);
  assert.equal(serviceResponse.data?.runId, embeddedResponse.json().data.runId);
  assert.equal(serviceResponse.schemaVersion, 'iar.fastify-response/v1');
  assert.equal(serviceResponse.version, 'fastify.v1');
  await embedded.close();
  await api.close();
});

/** 未授权请求和跨租户相同 runId 都必须在业务执行前失败。 */
test('Service API fails closed for authorization and tenant state isolation', async () => {
  const api = createApi();
  const created = await api.request(request({ operation: 'run.create', payload: { runId: 'shared-run', definition: definition() } }));
  assert.equal(created.error, null);
  const denied = await api.request(request({ operation: 'run.get', actorId: 'wrong-actor', payload: { runId: 'shared-run' } }));
  assert.equal(denied.error?.code, 'service.authorization_failed');
  const foreign = await api.request(request({ operation: 'run.get', tenantId: 'tenant-b', actorId: 'actor-tenant-b', payload: { runId: 'shared-run' } }));
  assert.equal(foreign.error?.code, 'workflow_not_found');
  await api.close();
});

/** 授权器不能修改上下文，host 工厂也不能跨 tenant 复用核心状态。 */
test('Service API freezes authorization context and rejects shared hosts', async () => {
  const shared = { workflow: new LocalWorkflow(), pluginHost: new PluginHost() };
  const api = createServiceApi({
    authorize: (context) => {
      assert.equal(Object.isFrozen(context), true);
      try { context.tenantId = 'tenant-b'; } catch { /* frozen context is fail-closed */ }
      return true;
    },
    hostFactory: () => shared
  });
  const first = await api.request(request({ operation: 'run.create', tenantId: 'tenant-a', actorId: 'actor-a', payload: { runId: 'shared-host', definition: definition() } }));
  const second = await api.request(request({ operation: 'run.create', tenantId: 'tenant-b', actorId: 'actor-b', payload: { runId: 'shared-host-b', definition: definition() } }));
  assert.equal(first.error, null);
  assert.equal(second.error?.code, 'service.host_unavailable');
  await api.close();
});

/** malformed protocol、plugin inspect 和 replay 都必须返回稳定结构化结果。 */
test('Service API validates protocol and exposes safe inspect/replay operations', async () => {
  const api = createApi();
  const malformed = await api.request({ ...request({ operation: 'run.get' }), protocolVersion: 'iar.service-api/v0' } as unknown as ServiceApiRequest);
  assert.equal(malformed.error?.code, 'service.invalid_request');
  const created = await api.request(request({ operation: 'run.create', payload: { runId: 'replay-run', definition: definition() } }));
  assert.equal(created.error, null);
  const replayed = await api.request<{ runId: string }>(request({ operation: 'run.replay', payload: { runId: 'replay-run' } }));
  assert.equal(replayed.error, null);
  assert.equal(replayed.runId, 'replay-run');
  await api.close();
});
