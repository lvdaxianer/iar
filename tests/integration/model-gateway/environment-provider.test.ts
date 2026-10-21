import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelProviderError,
  type ModelProviderRequest
} from '@iar/runtime';
import {
  BrainModelProvider,
  IntentModelProvider
} from '../../../examples/agent-sandbox/src/models/llm-provider.js';

const ENV_KEYS = [
  'IAR_TEST_NORMAL_ENDPOINT',
  'IAR_TEST_NORMAL_API_KEY',
  'IAR_TEST_NORMAL_MODEL',
  'IAR_LLM_BASE_URL',
  'IAR_LLM_API_KEY',
  'IAR_MODEL_API_KEY',
  'IAR_LLM_MODEL_ID',
  'IAR_TEST_INTENT_ENDPOINT',
  'IAR_TEST_INTENT_API_KEY',
  'IAR_TEST_INTENT_MODEL',
  'IAR_INTENT_MODEL_ENDPOINT',
  'IAR_INTENT_MODEL_API_KEY',
  'IAR_INTENT_MODEL_ID'
] as const;

type CapturedRequest = {
  url: string;
  init: RequestInit | undefined;
};

function request(profile: ModelProviderRequest['profile']): ModelProviderRequest {
  return {
    traceId: 'trace-provider-test',
    runId: 'run-provider-test',
    profile,
    input: { text: '查询订单状态' },
    attempt: 1,
    signal: new AbortController().signal
  };
}

function normalProfile(overrides: Partial<ModelProviderRequest['profile']> = {}): ModelProviderRequest['profile'] {
  return {
    schemaVersion: 'iar.model-profile/v1',
    profileId: 'normal-provider-test',
    profileVersion: '1.0.0',
    role: 'semantic.extract',
    provider: 'brain',
    modelId: 'profile-normal-model',
    modelVersion: 'test',
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    structuredOutput: { enabled: true, schemaId: 'iar.semantic-frame/v1' },
    environment: {
      endpoint: 'IAR_TEST_NORMAL_ENDPOINT',
      apiKey: 'IAR_TEST_NORMAL_API_KEY',
      modelId: 'IAR_TEST_NORMAL_MODEL'
    },
    ...overrides
  };
}

function intentProfile(overrides: Partial<ModelProviderRequest['profile']> = {}): ModelProviderRequest['profile'] {
  return {
    schemaVersion: 'iar.model-profile/v1',
    profileId: 'intent-provider-test',
    profileVersion: '1.0.0',
    role: 'function.select',
    decisionBackend: 'intent-model',
    provider: 'intent-model',
    modelId: 'profile-intent-model',
    modelVersion: 'test',
    timeoutMs: 1_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: [] },
    structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' },
    environment: {
      endpoint: 'IAR_TEST_INTENT_ENDPOINT',
      apiKey: 'IAR_TEST_INTENT_API_KEY',
      modelId: 'IAR_TEST_INTENT_MODEL'
    },
    ...overrides
  };
}

function setEnvironment(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function installFetch(body: unknown, status = 200): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

test('normal provider resolves endpoint, API key, and model ID from profile environment mappings', async () => {
  const restoreEnvironment = setEnvironment({
    IAR_TEST_NORMAL_ENDPOINT: 'https://normal.example/v1/',
    IAR_TEST_NORMAL_API_KEY: 'normal-secret',
    IAR_TEST_NORMAL_MODEL: 'normal-env-model'
  });
  const fetchStub = installFetch({ choices: [{ message: { content: '{"ok":true}' } }] });
  try {
    const result = await new BrainModelProvider().complete(request(normalProfile()));
    assert.deepEqual(result, { ok: true });
    assert.equal(fetchStub.requests.length, 1);
    assert.equal(fetchStub.requests[0]?.url, 'https://normal.example/v1/chat/completions');
    const init = fetchStub.requests[0]?.init;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer normal-secret');
    const body = JSON.parse(String(init?.body)) as { model: string; response_format: { type: string }; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'normal-env-model');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user']);
  } finally {
    fetchStub.restore();
    restoreEnvironment();
  }
});

test('Intent Model provider uses independent mappings and fixed decision prompt', async () => {
  const restoreEnvironment = setEnvironment({
    IAR_TEST_INTENT_ENDPOINT: 'https://intent.example/v1',
    IAR_TEST_INTENT_API_KEY: 'intent-secret',
    IAR_TEST_INTENT_MODEL: 'intent-env-model'
  });
  const fetchStub = installFetch({ choices: [{ message: { content: '{"schemaVersion":"iar.decision/v1"}' } }] });
  try {
    const result = await new IntentModelProvider().complete(request(intentProfile()));
    assert.deepEqual(result, { schemaVersion: 'iar.decision/v1' });
    assert.equal(fetchStub.requests[0]?.url, 'https://intent.example/v1/chat/completions');
    const body = JSON.parse(String(fetchStub.requests[0]?.init?.body)) as { model: string; response_format: { type: string }; messages: Array<{ role: string; content: string }> };
    assert.equal(body.model, 'intent-env-model');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0]?.content ?? '', /iar\.intent-decision-prompt\/v1/);
  } finally {
    fetchStub.restore();
    restoreEnvironment();
  }
});

test('provider falls back to profile model ID and fails closed when endpoint or API key is missing', async () => {
  const restoreEnvironment = setEnvironment({ IAR_TEST_NORMAL_ENDPOINT: undefined, IAR_TEST_NORMAL_API_KEY: undefined, IAR_TEST_NORMAL_MODEL: undefined });
  const fetchStub = installFetch({ choices: [{ message: { content: '{"ok":true}' } }] });
  try {
    await assert.rejects(
      () => new BrainModelProvider({ baseUrl: 'https://option.example/v1' }).complete(request(normalProfile({ environment: { apiKey: 'IAR_TEST_NORMAL_API_KEY', modelId: 'IAR_TEST_NORMAL_MODEL' } }))),
      (error: unknown) => error instanceof ModelProviderError && error.kind === 'provider_unavailable'
    );
    assert.equal(fetchStub.requests.length, 0);
    process.env.IAR_TEST_NORMAL_API_KEY = 'option-secret';
    const fallback = await new BrainModelProvider({ baseUrl: 'https://option.example/v1' }).complete(request(normalProfile({ environment: { apiKey: 'IAR_TEST_NORMAL_API_KEY', modelId: 'IAR_TEST_NORMAL_MODEL' } })));
    assert.deepEqual(fallback, { ok: true });
    const body = JSON.parse(String(fetchStub.requests[0]?.init?.body)) as { model: string };
    assert.equal(body.model, 'profile-normal-model');
  } finally {
    fetchStub.restore();
    restoreEnvironment();
  }
});

test('provider maps transport and malformed responses to stable errors without leaking secrets', async () => {
  const restoreEnvironment = setEnvironment({
    IAR_TEST_NORMAL_ENDPOINT: 'https://normal.example/v1',
    IAR_TEST_NORMAL_API_KEY: 'secret-that-must-not-leak',
    IAR_TEST_NORMAL_MODEL: 'normal-env-model'
  });
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('network secret-that-must-not-leak'); };
    await assert.rejects(
      () => new BrainModelProvider().complete(request(normalProfile())),
      (error: unknown) => error instanceof ModelProviderError && error.kind === 'provider_unavailable' && !String(error).includes('secret-that-must-not-leak')
    );
    globalThis.fetch = async () => new Response('upstream secret-that-must-not-leak', { status: 503 });
    await assert.rejects(
      () => new BrainModelProvider().complete(request(normalProfile())),
      (error: unknown) => error instanceof ModelProviderError && error.kind === 'provider_failed' && !String(error).includes('secret-that-must-not-leak')
    );
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [] }), { status: 200 });
    await assert.rejects(
      () => new BrainModelProvider().complete(request(normalProfile())),
      (error: unknown) => error instanceof ModelProviderError && error.kind === 'provider_failed' && !String(error).includes('secret-that-must-not-leak')
    );
  } finally {
    globalThis.fetch = previous;
    restoreEnvironment();
  }
});
