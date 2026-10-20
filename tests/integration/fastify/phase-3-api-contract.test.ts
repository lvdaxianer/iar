/**
 * 验证 Fastify API contract 在成功、插件失败和未知路由上的统一字段。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type WorkflowDefinition } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { createFastifyApp } from '@iar/adapters-fastify';
import { LocalWorkflow } from '@iar/workflow';

/**
 * 创建 API contract 使用的最小 WorkflowDefinition。
 * 初始状态必须是非终态，保持 LocalWorkflow 的真实启动校验。
 * 该 fixture 不依赖模型、插件执行器或外部存储。
 */
function definition(): WorkflowDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.workflow, workflowId: 'api-contract', version: '1.0.0', description: 'contract fixture', states: ['start', 'done'], initialState: 'start', terminalStates: ['done'], transitions: [{ event: 'finish', from: 'start', to: 'done' }] };
}

/**
 * 创建 contract test 独立的 Fastify 核心依赖。
 * 每个测试都使用独立的 Workflow 和 PluginHost，避免状态串扰。
 * Function 集合只包含本测试需要的稳定边界。
 */
function dependencies() {
  return { workflow: new LocalWorkflow(), pluginHost: new PluginHost() };
}

/**
 * 统一 envelope 必须在所有公开路由中保持固定字段集合。
 * data/error 互斥但都必须出现，客户端无需按路由猜字段。
 * trace/run/version 不能被业务错误路径省略。
 */
function assertEnvelope(body: Record<string, unknown>, traceId: string, runId: string): void {
  assert.deepEqual(Object.keys(body).sort(), ['data', 'error', 'runId', 'schemaVersion', 'traceId', 'version']);
  assert.equal(body.schemaVersion, 'iar.fastify-response/v1');
  assert.equal(body.version, 'fastify.v1');
  assert.equal(body.traceId, traceId);
  assert.equal(body.runId, runId);
}

/**
 * 创建 run 和查询状态的成功响应都必须有 error:null。
 * 两条不同 HTTP route 共享相同公共 envelope。
 * 查询结果不能因为序列化而暴露 Workflow definition。
 */
test('keeps success response shape stable across create and query', async () => {
  const app = await createFastifyApp(dependencies());
  const created = await app.inject({ method: 'POST', url: '/v1/runs', headers: { 'x-trace-id': 'trace-contract' }, payload: { runId: 'run-contract', definition: definition() } });
  assert.equal(created.statusCode, 201);
  assertEnvelope(created.json(), 'trace-contract', 'run-contract');
  assert.equal(created.json().error, null);
  const queried = await app.inject({ method: 'GET', url: '/v1/runs/run-contract', headers: { 'x-trace-id': 'trace-contract' } });
  assert.equal(queried.statusCode, 200);
  assertEnvelope(queried.json(), 'trace-contract', 'run-contract');
  assert.equal(queried.json().error, null);
  await app.close();
});

/**
 * 插件错误和未知路由必须保持同一 envelope，而不能退回框架默认 body。
 * query string 中的 apiKey 也不能被响应复制。
 * PluginHost 的稳定错误码仍需保留资源不存在语义。
 */
test('keeps plugin and route errors contract-shaped', async () => {
  // 插件错误、未知路由和 query 中的凭据都必须在同一安全响应边界内处理。
  // 不使用真实端口，避免 contract test 受环境监听状态影响。
  const app = await createFastifyApp(dependencies());
  const plugin = await app.inject({ method: 'POST', url: '/v1/plugins/missing/enable', headers: { 'x-trace-id': 'trace-plugin-contract' } });
  assert.equal(plugin.statusCode, 404);
  assertEnvelope(plugin.json(), 'trace-plugin-contract', '');
  assert.equal(plugin.json().data, null);
  assert.equal(plugin.json().error.code, 'plugin.unavailable');
  const route = await app.inject({ method: 'GET', url: '/v1/no-such-route?apiKey=not-returned', headers: { 'x-trace-id': 'trace-route-contract' } });
  assert.equal(route.statusCode, 404);
  assertEnvelope(route.json(), 'trace-route-contract', '');
  assert.equal(JSON.stringify(route.json()).includes('not-returned'), false);
  await app.close();
});
