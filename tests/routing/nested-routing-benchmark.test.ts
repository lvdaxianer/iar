/**
 * 为 nested Plugin tool 路由保留可重复的规模与参数边界基准。
 *
 * 基准使用 OpenAI-compatible provider 的本地 fetch 替身，不访问外部网络，
 * 因此结果用于比较请求规模和本地协议开销，不冒充真实供应商延迟。
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateJsonSchemaValue, type ActionType, type BusinessPluginManifest, type JsonValue } from '@iar/contracts';
import { PluginHost } from '@iar/plugins';
import { ModelGateway, ModelProfileRegistry, NestedRouteAdapter, type NestedFunctionToolDefinition, validateNestedFunctionCallProposal } from '@iar/runtime';
import { BrainModelProvider } from '../../examples/agent-sandbox/src/models/llm-provider.js';
import { buildFunctionCallInput } from '../../examples/agent-sandbox/src/session-helpers.js';
import { pluginPackage } from '../contract/fixtures/plugin-package.js';

const SCALE_POINTS = [1, 5, 10, 20, 40] as const;
type BenchmarkRecord = { plugins: number; tools: number; payloadBytes: number; ttfbMs: number; totalMs: number; successRate: number };

function manifest(pluginId: string): BusinessPluginManifest {
  return {
    apiVersion: 'iar.dev/v1', schemaVersion: SCHEMA_VERSIONS.pluginManifest, pluginId,
    pluginKind: 'business', scope: 'plugin', version: '1.0.0', description: `${pluginId} 基准插件`,
    capabilities: ['knowledge.read'], lifecycle: { entrypoint: `${pluginId}.entry` },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['knowledge.read'] }, dependencies: []
  };
}

function createHost(size: number): PluginHost {
  const host = new PluginHost();
  for (let index = 0; index < size; index += 1) {
    const pluginId = `benchmark-plugin-${String(index).padStart(2, '0')}`;
    const packageValue = pluginPackage(manifest(pluginId), `benchmark.query.${String(index)}`, {
      actionTypes: ['query'] as ActionType[],
      inputSchema: { type: 'object', properties: { operation: { type: 'string' }, query: { type: 'string' } }, required: ['operation'], additionalProperties: false }
    });
    assert.equal(host.install(packageValue).ok, true);
    assert.equal(host.enable(pluginId).ok, true);
  }
  return host;
}

function runtimeTools(host: PluginHost): NestedFunctionToolDefinition[] {
  return host.nestedTools().map((binding) => ({
    name: binding.tool.function.name,
    pluginId: binding.pluginId,
    description: binding.tool.function.description,
    parameters: binding.tool.function.parameters as JsonValue,
    candidates: binding.candidates.map((candidate) => ({ pluginId: candidate.pluginId, functionId: candidate.functionId, operations: candidate.operations.map((operation) => ({ name: operation.name })) }))
  }));
}

function routeProfile() {
  return {
    schemaVersion: 'iar.model-profile/v1' as const, profileId: 'benchmark-route-propose', profileVersion: '1.0.0', role: 'route.propose' as const,
    provider: 'brain', modelId: 'benchmark-model', modelVersion: 'test', timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] as const },
    structuredOutput: { enabled: true, schemaId: 'iar.nested-function-call/v1' },
    environment: { endpoint: 'IAR_BENCHMARK_ENDPOINT', apiKey: 'IAR_BENCHMARK_API_KEY', modelId: 'IAR_BENCHMARK_MODEL' }
  };
}

function routeGateway(): ModelGateway {
  return new ModelGateway({
    registry: new ModelProfileRegistry([routeProfile()]),
    providers: { brain: new BrainModelProvider({ apiKey: 'benchmark-key', baseUrl: 'http://benchmark.invalid/v1', modelId: 'benchmark-model' }) }
  });
}

async function measureScale(size: number): Promise<BenchmarkRecord> {
  const host = createHost(size);
  const tools = runtimeTools(host);
  const payloadBytes = Buffer.byteLength(JSON.stringify(host.nestedTools()), 'utf8');
  let fetchStartedAt = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const requestStartedAt = performance.now();
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: { properties?: Record<string, { enum?: string[] }> };
        };
      }>;
    };
    fetchStartedAt = performance.now();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstTool = body.tools?.[0]?.function;
    const functionId = firstTool?.parameters?.properties?.functionId?.enum?.[0] ?? `benchmark.query.0`;
    const operation = firstTool?.parameters?.properties?.operation?.enum?.[0] ?? 'execute';
    assert.ok(requestStartedAt <= fetchStartedAt);
    return Response.json({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: firstTool?.name, arguments: JSON.stringify({ functionId, operation, arguments: { operation } }) } }] } }] });
  };
  try {
    const start = performance.now();
    const result = await new NestedRouteAdapter(routeGateway()).call({ traceId: `benchmark-${size}`, runId: `benchmark-${size}`, input: { currentMessage: '查询基准数据' }, tools });
    const end = performance.now();
    assert.equal(result.ok, true);
    return { plugins: size, tools: tools.length, payloadBytes, ttfbMs: Number(Math.max(0, fetchStartedAt - start).toFixed(3)), totalMs: Number(Math.max(0, end - start).toFixed(3)), successRate: 1 };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('nested route benchmark records Plugin scale, request size, TTFB, total time and success rate', async () => {
  const records: BenchmarkRecord[] = [];
  for (const size of SCALE_POINTS) records.push(await measureScale(size));
  assert.deepEqual(records.map((record) => record.plugins), [...SCALE_POINTS]);
  assert.ok(records.every((record) => record.tools === Math.min(record.plugins, 32) && record.payloadBytes > 0 && record.successRate === 1));
  assert.ok(records.every((record) => record.ttfbMs >= 0 && record.totalMs >= 0));
  process.stdout.write(`nested-route-benchmark ${JSON.stringify(records)}\n`);
});

test('twenty named-argument cases preserve field identity regardless of JSON property order', () => {
  const tool: NestedFunctionToolDefinition = {
    name: 'plugin_parameter_accuracy', pluginId: 'parameter-plugin', description: '参数准确性测试',
    parameters: { type: 'object', properties: { functionId: { type: 'string', enum: ['parameter.query'] }, operation: { type: 'string', enum: ['read'] }, arguments: { type: 'object', additionalProperties: true } }, required: ['functionId', 'operation', 'arguments'], additionalProperties: false },
    candidates: [{ pluginId: 'parameter-plugin', functionId: 'parameter.query', operations: [{ name: 'read' }] }]
  };
  for (let index = 0; index < 20; index += 1) {
    const expected = { source: `source-${index}`, target: `target-${index}`, limit: index + 1 };
    const argumentsValue: Record<string, JsonValue> = index % 2 === 0
      ? { source: expected.source, target: expected.target, limit: expected.limit }
      : { limit: expected.limit, target: expected.target, source: expected.source };
    const proposal = validateNestedFunctionCallProposal({ schemaVersion: 'iar.nested-function-call/v1', pluginId: tool.pluginId, toolName: tool.name, functionId: 'parameter.query', operation: 'read', arguments: argumentsValue, confidence: 1 }, [tool]);
    assert.equal(proposal.ok, true);
    if (!proposal.ok) continue;
    const input = buildFunctionCallInput({ ...proposal.value, schemaVersion: 'iar.function-call/v1' });
    assert.deepEqual(input, { input: { ...expected, operation: 'read' } });
    assert.equal(validateJsonSchemaValue(input.input, { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' }, limit: { type: 'integer' }, operation: { type: 'string' } }, required: ['source', 'target', 'limit', 'operation'], additionalProperties: false }).ok, true);
  }
});

