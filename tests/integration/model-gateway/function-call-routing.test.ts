import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DecisionBackendResolver,
  FunctionCallAdapter,
  ModelProfileRegistry,
  ModelGateway,
  UnifiedFunctionCallAdapter,
  validateFunctionCallProposal,
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

function profile(role: 'function.call', backend?: 'jev' | 'intent-model') {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId: `${backend ?? 'brain'}-function-call`,
    profileVersion: '1.0.0',
    role,
    ...(backend ? { decisionBackend: backend } : {}),
    provider: backend === 'intent-model' ? 'intent-provider' : backend === 'jev' ? 'jev-provider' : 'brain',
    modelId: 'function-call-model',
    modelVersion: 'test',
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] },
    structuredOutput: { enabled: true, schemaId: 'iar.function-call/v1' },
    environment: { endpoint: 'IAR_TEST_ENDPOINT', apiKey: 'IAR_TEST_API_KEY', modelId: 'IAR_TEST_MODEL' }
  };
}

function providerRequest(input: JsonValue): ModelProviderRequest {
  return {
    traceId: 'trace-function-call',
    runId: 'run-function-call',
    profile: profile('function.call'),
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

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
