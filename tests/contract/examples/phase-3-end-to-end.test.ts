/**
 * 验证三个示例从 Fastify install/enable API 到真实 SDK Handler 的确定性端到端边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginRegistration } from '@iar/plugin-sdk';
import { createFastifyApp } from '@iar/adapters-fastify';
import { PluginHost } from '@iar/plugin-host';
import { LocalWorkflow } from '@iar/workflow';
import { knowledgeQueryPlugin } from '../../../examples/knowledge-query/src/index.js';
import { ticketCreatePlugin } from '../../../examples/ticket-create/src/index.js';
import { humanTransferPlugin } from '../../../examples/human-transfer/src/index.js';

/**
 * 端到端 fixture 只安装三个示例，不依赖真实模型或外部系统。
 * HTTP 只传输 Manifest；本地 Handler 由宿主加载边界绑定。
 */
type ExampleRegistration = PluginRegistration & { manifest: FunctionPluginManifest };
const plugins: readonly ExampleRegistration[] = [knowledgeQueryPlugin as ExampleRegistration, ticketCreatePlugin as ExampleRegistration, humanTransferPlugin as ExampleRegistration];

/**
 * 构造隔离的 API/PluginHost 组合。
 * Fastify 负责生命周期入口，PluginHost 负责真实 Handler 记录。
 * 测试不启动端口，也不调用任何外部服务。
 */
function dependencies(): { workflow: LocalWorkflow; pluginHost: PluginHost } {
  return { workflow: new LocalWorkflow(), pluginHost: new PluginHost({ functionIds: plugins.map(({ manifest }) => manifest.functionId) }) };
}

/**
 * 三个示例的输入必须是可通过 Manifest inputSchema 的确定性 fixture。
 * 只返回本地 JSON，避免端到端测试引入时间和网络不确定性。
 */
function inputFor(pluginId: string): JsonValue {
  if (pluginId === 'knowledge-query-v1') return { query: 'restart policy', topK: 2 };
  if (pluginId === 'ticket-create-v1') return { title: 'Service incident', description: 'test1 is unavailable', priority: 'high' };
  return { reason: 'requires human review', summary: 'test1 needs review' };
}

/**
 * Fastify install 路由必须真实接收三个 Manifest，并返回受限的 Plugin 摘要。
 * Handler 函数不能通过 JSON 传输，因此 Handler 执行边界由下一个测试通过本地注册覆盖。
 * 该测试专门防止 install 路由被绕过后仍然出现假绿。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('installs every example manifest through the Fastify boundary', async () => {
  const { workflow, pluginHost } = dependencies();
  const app = await createFastifyApp({ workflow, pluginHost });
  for (const plugin of plugins) {
    const response = await app.inject({ method: 'POST', url: '/v1/plugins/install', headers: { 'x-trace-id': `trace-install-${plugin.manifest.pluginId}` }, payload: { manifest: plugin.manifest } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().data.plugin.pluginId, plugin.manifest.pluginId);
    assert.equal(response.json().data.plugin.version, plugin.manifest.version);
  }
  await app.close();
});

/**
 * Fastify 启用后，Handler 结果仍需通过同一 Manifest outputSchema。
 * 每个示例都走真实 PluginHost 状态和真实 SDK Handler。
 * 失败应归因于本地 contract，而不是被 adapter 假装成功。
 */
test('runs every example through host API and deterministic SDK handler', async () => {
  // 先由本地 Host 绑定 Handler，再由 Fastify 驱动 enable，模拟宿主加载与 API 控制面的边界。
  // 每个结果都必须保持确定性并通过同一 Manifest outputSchema。
  const { workflow, pluginHost } = dependencies();
  const app = await createFastifyApp({ workflow, pluginHost });
  for (const plugin of plugins) {
    // HTTP 只传输 Manifest；宿主先绑定本地 SDK Handler，再由 API 驱动生命周期。
    assert.equal(pluginHost.install(plugin).ok, true);
    const enabled = await app.inject({ method: 'POST', url: `/v1/plugins/${plugin.manifest.pluginId}/enable`, headers: { 'x-trace-id': `trace-${plugin.manifest.pluginId}` } });
    assert.equal(enabled.statusCode, 200);
    const record = pluginHost.get(plugin.manifest.pluginId);
    assert.ok(record?.handler);
    const result = await record.handler(inputFor(plugin.manifest.pluginId), { pluginId: plugin.manifest.pluginId, functionId: plugin.manifest.functionId, runId: `run-${plugin.manifest.pluginId}`, correlationId: `trace-${plugin.manifest.pluginId}` });
    assert.equal(result.status, 'succeeded');
    assert.equal(new Ajv2020({ strict: false }).compile(plugin.manifest.outputSchema)(result.output), true);
  }
  await app.close();
});
