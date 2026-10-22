import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionBackendResolver,
  FunctionCallAdapter,
  ModelProfileRegistry,
  ModelGateway,
  NestedFunctionCallAdapter,
  NestedRouteAdapter,
  UnifiedFunctionCallAdapter,
  validateFunctionCallProposal,
  validateNestedFunctionCallProposal,
  type NestedFunctionToolDefinition,
  type FunctionToolDefinition
} from '@iar/runtime';
import type { JsonValue } from '@iar/contracts';
import { BrainModelProvider } from '../../../examples/agent-sandbox/src/models/llm-provider.js';
import type { ModelProviderRequest } from '@iar/runtime';

const tool: FunctionToolDefinition = {
  name: 'ticket.query',
  pluginId: 'ticket-plugin',
  functionId: 'ticket.query',
  description: '查询工单状态',
  parameters: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'], additionalProperties: false }
};

const nestedTool: NestedFunctionToolDefinition = {
  name: 'plugin_ticket',
  pluginId: 'ticket-plugin',
  description: '工单 Plugin，支持查询工单',
  parameters: {
    type: 'object',
    properties: {
      functionId: { type: 'string', enum: ['ticket.query'] },
      operation: { type: 'string', enum: ['query'] },
      arguments: { type: 'object', additionalProperties: true }
    },
    required: ['functionId', 'operation', 'arguments'],
    additionalProperties: false
  },
  candidates: [{ pluginId: 'ticket-plugin', functionId: 'ticket.query', operations: [{ name: 'query' }] }]
};

function profile(role: 'function.call' | 'route.propose', backend?: 'jev' | 'intent-model', timeoutMs = 1_000) {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId: `${backend ?? 'brain'}-function-call`,
    profileVersion: '1.0.0',
    role,
    ...(backend ? { decisionBackend: backend } : {}),
    provider: backend === 'intent-model' ? 'intent-provider' : backend === 'jev' ? 'jev-provider' : 'brain',
    modelId: 'function-call-model',
    modelVersion: 'test',
    timeoutMs,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] },
    structuredOutput: { enabled: true, schemaId: role === 'route.propose' ? 'iar.nested-function-call/v1' : 'iar.function-call/v1' },
    environment: { endpoint: 'IAR_TEST_ENDPOINT', apiKey: 'IAR_TEST_API_KEY', modelId: 'IAR_TEST_MODEL' }
  };
}

function providerRequest(input: JsonValue, role: 'function.call' | 'route.propose' = 'function.call'): ModelProviderRequest {
  return {
    traceId: 'trace-function-call',
    runId: 'run-function-call',
    profile: profile(role),
    input,
    attempt: 1,
    signal: new AbortController().signal
  };
}

test('function-call proposal validates the installed tool identity and arguments', () => {
  const result = validateFunctionCallProposal({
    schemaVersion: 'iar.function-call/v1',
    pluginId: 'ticket-plugin',
    functionId: 'ticket.query',
    operation: 'read',
    arguments: { ticketId: 'ticket-1' },
    confidence: 0.96
  }, [tool]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.arguments, { ticketId: 'ticket-1' });
});

test('function-call proposal rejects unknown tools and model-owned contract fields', () => {
  const unknownTool = validateFunctionCallProposal({
    schemaVersion: 'iar.function-call/v1',
    pluginId: 'other-plugin',
    functionId: 'other.query',
    operation: 'read',
    arguments: {},
    confidence: 0.9
  }, [tool]);
  assert.equal(unknownTool.ok, false);

  const customSchema = validateFunctionCallProposal({
    schemaVersion: 'iar.function-call/v1',
    pluginId: 'ticket-plugin',
    functionId: 'ticket.query',
    operation: 'read',
    arguments: {},
    confidence: 0.9,
    parameters: { type: 'object' }
  }, [tool]);
  assert.equal(customSchema.ok, false);
});

test('nested Function-call proposal preserves Plugin ownership and named arguments', () => {
  const result = validateNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1',
    pluginId: 'ticket-plugin',
    toolName: 'plugin_ticket',
    functionId: 'ticket.query',
    operation: 'query',
    arguments: { ticketId: 'ticket-1' },
    confidence: 0.97
  }, [nestedTool]);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.arguments, { ticketId: 'ticket-1' });

  const unknownOperation = validateNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1', pluginId: 'ticket-plugin', toolName: 'plugin_ticket', functionId: 'ticket.query', operation: 'create', arguments: {}, confidence: 0.9
  }, [nestedTool]);
  assert.equal(unknownOperation.ok, false);
});

test('nested Function-call proposal rejects duplicate Function identities in one Plugin tool', () => {
  const duplicateTool = {
    ...nestedTool,
    candidates: [
      ...nestedTool.candidates,
      { pluginId: 'ticket-plugin', functionId: 'ticket.query', operations: [{ name: 'query' }] }
    ]
  };
  const result = validateNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1',
    pluginId: 'ticket-plugin',
    toolName: 'plugin_ticket',
    functionId: 'ticket.query',
    operation: 'query',
    arguments: { ticketId: 'ticket-1' },
    confidence: 0.97
  }, [duplicateTool]);

  assert.equal(result.ok, false);
});

test('nested Function-call proposal rejects non-object named arguments', () => {
  const result = validateNestedFunctionCallProposal({
    schemaVersion: 'iar.nested-function-call/v1',
    pluginId: 'ticket-plugin',
    toolName: 'plugin_ticket',
    functionId: 'ticket.query',
    operation: 'query',
    arguments: ['ticket-1'],
    confidence: 0.97
  }, [nestedTool]);

  assert.equal(result.ok, false);
});

test('function.call model profile uses JEV first and Intent Model only when JEV is absent', () => {
  const jevFirst = new ModelProfileRegistry([profile('function.call', 'jev'), profile('function.call', 'intent-model')]);
  assert.deepEqual(new DecisionBackendResolver(jevFirst).resolve('function.call'), {
    role: 'function.call',
    backend: 'jev',
    profileId: 'jev-function-call'
  });

  const intentFallback = new ModelProfileRegistry([profile('function.call', 'intent-model')]);
  assert.deepEqual(new DecisionBackendResolver(intentFallback).resolve('function.call'), {
    role: 'function.call',
    backend: 'intent-model',
    profileId: 'intent-model-function-call'
  });
});

test('route.propose uses the normal interaction model once and never resolves JEV/Intent compatibility backends', async () => {
  const calls: string[] = [];
  const profiles = new ModelProfileRegistry([
    profile('route.propose'),
    profile('function.call', 'jev'),
    profile('function.call', 'intent-model')
  ]);
  const gateway = new ModelGateway({
    registry: profiles,
    providers: {
      brain: { complete: async (request) => { calls.push(`${request.profile.role}:${request.profile.provider}`); return { schemaVersion: 'iar.nested-function-call/v1', pluginId: 'ticket-plugin', toolName: 'plugin_ticket', functionId: 'ticket.query', operation: 'query', arguments: { ticketId: 'ticket-1' }, confidence: 1 }; } },
      'jev-provider': { complete: async () => { throw new Error('JEV compatibility backend must not run'); } },
      'intent-provider': { complete: async () => { throw new Error('Intent compatibility backend must not run'); } }
    }
  });
  const result = await new NestedRouteAdapter(gateway).call({ traceId: 'trace-route-propose', runId: 'run-route-propose', input: { currentMessage: '查 ticket-1' }, tools: [nestedTool] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['route.propose:brain']);
});

test('unified Function-call adapter sends only the selected Plugin tools to the selected backend', async () => {
  const calls: string[] = [];
  const profiles = new ModelProfileRegistry([profile('function.call', 'jev'), profile('function.call', 'intent-model')]);
  const gateway = new ModelGateway({
    registry: profiles,
    providers: {
      'jev-provider': { complete: async (request) => { calls.push(String(request.profile.provider)); return { schemaVersion: 'iar.function-call/v1', pluginId: 'ticket-plugin', functionId: 'ticket.query', operation: 'read', arguments: { ticketId: 'ticket-1' }, confidence: 0.9 }; } },
      'intent-provider': { complete: async () => { throw new Error('intent backend must not run'); } }
    }
  });
  const adapter = new UnifiedFunctionCallAdapter(new DecisionBackendResolver(profiles), new FunctionCallAdapter(gateway, 'jev'), new FunctionCallAdapter(gateway, 'intent-model'));
  const result = await adapter.call({ traceId: 'trace-adapter', runId: 'run-adapter', input: { currentMessage: '查 ticket-1' }, tools: [tool] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['jev-provider']);
  if (result.ok) assert.equal(result.value.functionId, 'ticket.query');
});

test('function.call transport sends bounded tools and parses a native tool call', async () => {
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env.IAR_TEST_ENDPOINT;
  const previousApiKey = process.env.IAR_TEST_API_KEY;
  const previousModel = process.env.IAR_TEST_MODEL;
  process.env.IAR_TEST_ENDPOINT = 'https://model.example/v1';
  process.env.IAR_TEST_API_KEY = 'test-secret';
  process.env.IAR_TEST_MODEL = 'test-function-model';
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'ticket.query', arguments: '{"ticketId":"ticket-1"}' } }] } }] }), { status: 200 });
  };
  try {
    const result = await new BrainModelProvider().complete(providerRequest({ currentMessage: '查 ticket-1', semantic: { slots: { query: 'ticket-1' } }, tools: [tool] }));
    assert.deepEqual(result, {
      schemaVersion: 'iar.function-call/v1',
      pluginId: 'ticket-plugin',
      functionId: 'ticket.query',
      operation: 'read',
      arguments: { ticketId: 'ticket-1' },
      confidence: 1
    });
    assert.equal(Array.isArray(body?.tools), true);
    assert.deepEqual(body?.tool_choice, { type: 'function', function: { name: 'ticket.query' } });
    const messages = Array.isArray(body?.messages) ? body.messages as Array<{ role?: string; content?: string }> : [];
    assert.match(messages.find((message) => message.role === 'user')?.content ?? '', /ticket-1/u);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('IAR_TEST_ENDPOINT', previousEndpoint);
    restoreEnvironment('IAR_TEST_API_KEY', previousApiKey);
    restoreEnvironment('IAR_TEST_MODEL', previousModel);
  }
});

test('nested Function-call transport sends OpenAI tools with thinking disabled', async () => {
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env.IAR_TEST_ENDPOINT;
  const previousApiKey = process.env.IAR_TEST_API_KEY;
  const previousModel = process.env.IAR_TEST_MODEL;
  process.env.IAR_TEST_ENDPOINT = 'https://model.example/v1';
  process.env.IAR_TEST_API_KEY = 'test-secret';
  process.env.IAR_TEST_MODEL = 'test-nested-model';
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'plugin_ticket', arguments: '{"functionId":"ticket.query","operation":"query","arguments":{"ticketId":"ticket-1"}}' } }] } }] }), { status: 200 });
  };
  try {
    const result = await new BrainModelProvider().complete(providerRequest({ currentMessage: '查 ticket-1', nestedTools: [nestedTool] } as unknown as JsonValue));
    assert.deepEqual(result, {
      schemaVersion: 'iar.nested-function-call/v1',
      pluginId: 'ticket-plugin',
      toolName: 'plugin_ticket',
      functionId: 'ticket.query',
      operation: 'query',
      arguments: { ticketId: 'ticket-1' },
      confidence: 1
    });
    assert.deepEqual(body?.thinking, { type: 'disabled' });
    assert.deepEqual(body?.tools, [{ type: 'function', function: { name: 'plugin_ticket', description: '工单 Plugin，支持查询工单', parameters: nestedTool.parameters } }]);
    const systemMessage = (Array.isArray(body?.messages) ? body.messages : []).find((message) => (message as { role?: string }).role === 'system') as { content?: string } | undefined;
    assert.match(systemMessage?.content ?? '', /逐字复制工具提供的 pluginId、functionId 和 operation/u);
    assert.match(systemMessage?.content ?? '', /不要使用位置参数/u);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('IAR_TEST_ENDPOINT', previousEndpoint);
    restoreEnvironment('IAR_TEST_API_KEY', previousApiKey);
    restoreEnvironment('IAR_TEST_MODEL', previousModel);
  }
});

test('route.propose transport uses the same OpenAI nested tool contract', async () => {
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env.IAR_TEST_ENDPOINT;
  const previousApiKey = process.env.IAR_TEST_API_KEY;
  const previousModel = process.env.IAR_TEST_MODEL;
  process.env.IAR_TEST_ENDPOINT = 'https://model.example/v1';
  process.env.IAR_TEST_API_KEY = 'test-secret';
  process.env.IAR_TEST_MODEL = 'test-route-model';
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'plugin_ticket', arguments: '{"functionId":"ticket.query","operation":"query","arguments":{"ticketId":"ticket-1"}}' } }] } }] }), { status: 200 });
  };
  try {
    const result = await new BrainModelProvider().complete(providerRequest({ currentMessage: '查 ticket-1', nestedTools: [nestedTool] } as unknown as JsonValue, 'route.propose'));
    assert.equal((result as { schemaVersion: string }).schemaVersion, 'iar.nested-function-call/v1');
    assert.deepEqual(body?.thinking, { type: 'disabled' });
    assert.deepEqual(body?.tools, [{ type: 'function', function: { name: 'plugin_ticket', description: '工单 Plugin，支持查询工单', parameters: nestedTool.parameters } }]);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('IAR_TEST_ENDPOINT', previousEndpoint);
    restoreEnvironment('IAR_TEST_API_KEY', previousApiKey);
    restoreEnvironment('IAR_TEST_MODEL', previousModel);
  }
});

test('nested Function-call transport rejects unknown tool and malformed JSON arguments', async () => {
  const previousFetch = globalThis.fetch;
  const previousEndpoint = process.env.IAR_TEST_ENDPOINT;
  const previousApiKey = process.env.IAR_TEST_API_KEY;
  const previousModel = process.env.IAR_TEST_MODEL;
  process.env.IAR_TEST_ENDPOINT = 'https://model.example/v1';
  process.env.IAR_TEST_API_KEY = 'test-secret';
  process.env.IAR_TEST_MODEL = 'test-nested-model';
  let responseBody: unknown = { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'plugin_unknown', arguments: '{}' } }] } }] };
  globalThis.fetch = async () => new Response(JSON.stringify(responseBody), { status: 200 });
  try {
    await assert.rejects(() => new BrainModelProvider().complete(providerRequest({ nestedTools: [nestedTool] } as unknown as JsonValue)));
    responseBody = { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'plugin_ticket', arguments: '{bad-json' } }] } }] };
    await assert.rejects(() => new BrainModelProvider().complete(providerRequest({ nestedTools: [nestedTool] } as unknown as JsonValue)));
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnvironment('IAR_TEST_ENDPOINT', previousEndpoint);
    restoreEnvironment('IAR_TEST_API_KEY', previousApiKey);
    restoreEnvironment('IAR_TEST_MODEL', previousModel);
  }
});

test('nested Function-call adapter classifies no tool call and timeout without executing anything', async () => {
  const noToolGateway = new ModelGateway({
    registry: new ModelProfileRegistry([profile('function.call')]),
    providers: { brain: { complete: async () => ({}) } }
  });
  const noToolResult = await new NestedFunctionCallAdapter(noToolGateway).call({ traceId: 'trace-no-tool', runId: 'run-no-tool', input: { currentMessage: '查工单' }, tools: [nestedTool] });
  assert.equal(noToolResult.ok, false);
  if (!noToolResult.ok) assert.equal(noToolResult.error.code, 'model.schema_invalid');

  const timeoutGateway = new ModelGateway({
    registry: new ModelProfileRegistry([profile('function.call', undefined, 10)]),
    providers: { brain: { complete: async () => await new Promise(() => undefined) } }
  });
  const timeoutResult = await new NestedFunctionCallAdapter(timeoutGateway).call({ traceId: 'trace-timeout', runId: 'run-timeout', input: { currentMessage: '查工单' }, tools: [nestedTool] });
  assert.equal(timeoutResult.ok, false);
  if (!timeoutResult.ok) assert.equal(timeoutResult.error.code, 'model.timeout');
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
