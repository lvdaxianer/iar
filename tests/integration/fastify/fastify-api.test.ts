/**
 * 验证 Fastify adapter 的统一响应、Workflow delegation、Plugin lifecycle 和敏感字段边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { SCHEMA_VERSIONS, type FunctionPluginManifest, type WorkflowDefinition } from '@iar/contracts';
import { PluginHost } from '@iar/plugin-host';
import { LocalWorkflow, confirmationScopeHash } from '@iar/workflow';
import { createFastifyApp, type FastifyHostOptions } from '@iar/adapters-fastify';

/**
 * 创建可供 API contract test 使用的最小状态机。
 *
 * @returns 合法 WorkflowDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function definition(): WorkflowDefinition {
  return { schemaVersion: SCHEMA_VERSIONS.workflow, workflowId: 'api-run', version: '1.0.0', description: 'API test workflow', states: ['start', 'awaiting_confirmation', 'done'], initialState: 'start', terminalStates: ['done'], transitions: [{ event: 'request_confirmation', from: 'start', to: 'awaiting_confirmation' }, { event: 'confirm', from: 'awaiting_confirmation', to: 'done' }] };
}

/**
 * 读取已经通过 contracts 校验的业务插件 fixture。
 *
 * @returns 合法 FunctionPluginManifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function manifest(): FunctionPluginManifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'tests', 'contract', 'fixtures', 'valid-plugin-manifest.json'), 'utf8')) as FunctionPluginManifest;
}

/**
 * 创建每个测试独立的 Fastify adapter 依赖。
 *
 * @returns FastifyHostOptions
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function options(): FastifyHostOptions {
  return { workflow: new LocalWorkflow(), pluginHost: new PluginHost({ functionIds: ['dip.service.stop'] }) };
}

/**
 * 构造需要确认的 Action 请求。
 *
 * @param runId - API 运行标识
 * @returns 绑定当前 run 的 ActionDefinition
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(runId: string) {
  return { schemaVersion: SCHEMA_VERSIONS.action, actionId: `${runId}-action`, runId, functionId: 'dip.service.stop', pluginId: 'dip-api-stop-v1', idempotencyKey: `${runId}-idempotency`, input: { serviceId: 'test1', password: 'do-not-return' }, riskLevel: 'high' as const, confirmationRequired: true };
}

/**
 * 断言统一 response envelope 包含 correlation 字段。
 *
 * @param body - HTTP response body
 * @param traceId - 预期 traceId
 * @param runId - 预期 runId
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertEnvelope(body: Record<string, unknown>, traceId: string, runId: string): void {
  assert.equal(body.schemaVersion, 'iar.fastify-response/v1');
  assert.equal(body.traceId, traceId);
  assert.equal(body.runId, runId);
  assert.equal(body.version, 'fastify.v1');
}

/**
 * 断言公开响应没有出现任何内部敏感输入。
 *
 * @param body - HTTP response body
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertSafe(body: unknown): void {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('api-secret'), false);
  assert.equal(serialized.includes('do-not-return'), false);
  assert.equal(serialized.includes('Bearer internal'), false);
}

/**
 * API run 创建、状态查询、follow-up input 和确认使用同一 envelope。
 * 测试同时验证原始 prompt、key、authorization 和 Action password 不出现在响应。
 * confirmation 继续由生产 LocalWorkflow 校验 scope，而不是由 adapter 模拟。
 * response data 只允许公共状态摘要，不能通过深拷贝重新带出内部 Action。
 */
test('creates, updates and confirms a run without exposing raw input', async () => {
  const app = await createFastifyApp(options());
  const runId = 'run-api-1';
  const created = await app.inject({ method: 'POST', url: '/v1/runs', headers: { 'x-trace-id': 'trace-api-1' }, payload: { traceId: 'trace-api-1', runId, definition: definition(), input: { rawPrompt: 'private prompt', apiKey: 'api-secret' } } });
  assert.equal(created.statusCode, 201);
  assertEnvelope(created.json(), 'trace-api-1', runId);
  assertSafe(created.json());

  const input = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/input`, headers: { 'x-trace-id': 'trace-api-1' }, payload: { traceId: 'trace-api-1', input: { rawPrompt: 'private prompt', authorization: 'Bearer internal' } } });
  assert.equal(input.statusCode, 202);
  assertEnvelope(input.json(), 'trace-api-1', runId);
  assertSafe(input.json());

  const state = await app.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: { 'x-trace-id': 'trace-api-1' } });
  assert.equal(state.statusCode, 200);
  assertEnvelope(state.json(), 'trace-api-1', runId);
  assert.equal(state.json().data.runId, runId);
  assertSafe(state.json());

  const target = action(runId);
  const confirmed = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/confirm`, headers: { 'x-trace-id': 'trace-api-1' }, payload: { traceId: 'trace-api-1', action: target, scopeHash: confirmationScopeHash(target), confirmedAt: '2026-10-17T00:00:00.000Z' } });
  assert.equal(confirmed.statusCode, 200);
  assertEnvelope(confirmed.json(), 'trace-api-1', runId);
  assert.equal(confirmed.json().data.confirmation.state, 'confirmed');
  assertSafe(confirmed.json());
  await app.close();
});

/**
 * malformed body 必须稳定失败，且 error 也不能携带 raw payload。
 * 不存在的 run 使用 404，非法输入使用 400，客户端可稳定区分两类边界。
 * error envelope 不允许复制 Fastify 或 Workflow 的内部异常对象。
 * 所有失败分支仍需保留 traceId、runId、version 和 error。
 */
test('returns versioned stable errors for malformed and unknown runs', async () => {
  const app = await createFastifyApp(options());
  const malformed = await app.inject({ method: 'POST', url: '/v1/runs', headers: { 'x-trace-id': 'trace-invalid' }, payload: { traceId: 'trace-invalid', runId: '', definition: { prompt: 'private prompt' } } });
  assert.equal(malformed.statusCode, 400);
  assertEnvelope(malformed.json(), 'trace-invalid', '');
  assert.equal(malformed.json().error.code, 'api.invalid_request');
  assertSafe(malformed.json());

  // Fastify JSON parser 失败也必须经过 adapter 的统一错误边界。
  // 解析错误不能暴露框架错误对象、原始 body 或内部 parser message。
  // header traceId 在 body 不可解析时仍然作为唯一链路标识保留。
  // 错误响应继续使用 data=null 和稳定 api.invalid_request。
  // 该路径验证路由 handler 之外的请求边界仍然满足公共契约。
  // 这也是生产客户端处理坏请求时的 fail-closed 入口。
  const invalidJson = await app.inject({ method: 'POST', url: '/v1/runs', headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-invalid-json' }, payload: '{"runId":' });
  assert.equal(invalidJson.statusCode, 400);
  assertEnvelope(invalidJson.json(), 'trace-invalid-json', '');
  assert.equal(invalidJson.json().error.code, 'api.invalid_request');
  assertSafe(invalidJson.json());

  // 未知路由不能退回 Fastify 默认的非 envelope 404 body。
  // route-not-found 错误码与资源不存在的 workflow_not_found 保持区分。
  // 未知路径的 query 也不进入响应或日志，避免凭据从 URL 泄漏。
  // response 仍保留 traceId、runId、version 和 error 四个公共字段。
  // 该断言覆盖 adapter 的全局 not-found 边界，而不是业务路由分支。
  const missingRoute = await app.inject({ method: 'GET', url: '/v1/unknown', headers: { 'x-trace-id': 'trace-missing-route' } });
  assert.equal(missingRoute.statusCode, 404);
  assertEnvelope(missingRoute.json(), 'trace-missing-route', '');
  assert.equal(missingRoute.json().error.code, 'api.route_not_found');
  assertSafe(missingRoute.json());

  const missing = await app.inject({ method: 'GET', url: '/v1/runs/missing-run', headers: { 'x-trace-id': 'trace-missing' } });
  assert.equal(missing.statusCode, 404);
  assertEnvelope(missing.json(), 'trace-missing', 'missing-run');
  assert.equal(missing.json().error.code, 'workflow_not_found');
  assertSafe(missing.json());
  await app.close();
});

/**
 * plugin lifecycle API 只能返回有限 manifest 摘要。
 * 安装、启用、禁用都必须经过同一个 PluginHost 实例。
 * 完整 schema、lifecycle 和 capability 配置不能被 HTTP 响应带出。
 */
test('delegates plugin install, enable and disable with safe summaries', async () => {
  const app = await createFastifyApp(options());
  const plugin = manifest();
  const installed = await app.inject({ method: 'POST', url: '/v1/plugins/install', headers: { 'x-trace-id': 'trace-plugin' }, payload: { traceId: 'trace-plugin', manifest: plugin } });
  assert.equal(installed.statusCode, 201);
  assertEnvelope(installed.json(), 'trace-plugin', '');
  assert.deepEqual(installed.json().data.plugin, { pluginId: plugin.pluginId, functionId: plugin.functionId, version: plugin.version, state: 'installed' });
  assertSafe(installed.json());

  const enabled = await app.inject({ method: 'POST', url: `/v1/plugins/${plugin.pluginId}/enable`, headers: { 'x-trace-id': 'trace-plugin' } });
  assert.equal(enabled.statusCode, 200);
  assert.equal(enabled.json().data.plugin.state, 'enabled');

  const disabled = await app.inject({ method: 'POST', url: `/v1/plugins/${plugin.pluginId}/disable`, headers: { 'x-trace-id': 'trace-plugin' } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().data.plugin.state, 'disabled');
  assertSafe(disabled.json());

  // PluginHost 的未知插件错误应保留资源不存在语义，而不是被 adapter 误报为 400。
  // 错误码来自 PluginHost，HTTP 状态只做稳定映射，不泄露内部 details。
  // 该回归确保 lower-case contract error 与状态映射大小写无关。
  // 失败响应仍复用同一个 versioned envelope。
  // 未知插件不能创建任何新的生命周期记录。
  const missingPlugin = await app.inject({ method: 'POST', url: '/v1/plugins/missing-plugin/enable', headers: { 'x-trace-id': 'trace-missing-plugin' } });
  assert.equal(missingPlugin.statusCode, 404);
  assertEnvelope(missingPlugin.json(), 'trace-missing-plugin', '');
  assert.equal(missingPlugin.json().error.code, 'plugin.unavailable');
  assertSafe(missingPlugin.json());
  await app.close();
});

/**
 * confirm 的 scope 不匹配必须由 LocalWorkflow 保持原语义拒绝。
 * adapter 只映射 reasonCode 和 HTTP 状态，不改变 confirmation 语义。
 * 错误响应仍然保留 trace/run/version/error 四个公共字段。
 */
test('preserves confirmation scope rejection through the API boundary', async () => {
  const app = await createFastifyApp(options());
  const runId = 'run-confirm-invalid';
  await app.inject({ method: 'POST', url: '/v1/runs', headers: { 'x-trace-id': 'trace-confirm' }, payload: { traceId: 'trace-confirm', runId, definition: definition() } });
  const target = action(runId);
  const result = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/confirm`, headers: { 'x-trace-id': 'trace-confirm' }, payload: { traceId: 'trace-confirm', action: target, scopeHash: 'wrong-scope', confirmedAt: '2026-10-17T00:00:00.000Z' } });
  assert.equal(result.statusCode, 409);
  assertEnvelope(result.json(), 'trace-confirm', runId);
  assert.equal(result.json().error.code, 'confirmation_scope_mismatch');
  assertSafe(result.json());
  await app.close();
});
