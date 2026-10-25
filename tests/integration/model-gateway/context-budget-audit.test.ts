import assert from 'node:assert/strict';
import test from 'node:test';
import type { BehaviorContext, DecisionResult, JsonValue } from '@iar/contracts';
import { INTENT_CONTEXT_BUDGET_CHARS, IntentModelDecisionAdapter, ModelGateway, ModelProfileRegistry, createInitialContext, type ContextBudgetDiagnostics, type DecisionRequest, type ModelInvocation, type ModelProvider, type ModelProviderRequest } from '@iar/runtime';
import { OpenAICompatibleModelProvider } from '../../../examples/agent-sandbox/src/models/llm-provider.js';

function profile() {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId: 'function-primary',
    profileVersion: '1.0.0',
    role: 'function.select' as const,
    decisionBackend: 'intent-model' as const,
    provider: 'intent-provider',
    modelId: 'intent-model',
    modelVersion: 'intent-v1',
    timeoutMs: 100,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] },
    structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' as const }
  };
}

function diagnostics(truncated: boolean): ContextBudgetDiagnostics {
  return { budgetChars: 24_000, measuredChars: truncated ? 23_000 : 1_000, truncated, retained: { factHistory: truncated ? 3 : 0, recentMessages: truncated ? 2 : 0 } };
}

function invocation(contextBudget?: ContextBudgetDiagnostics): ModelInvocation {
  return {
    traceId: 'trace-budget-audit',
    runId: 'run-budget-audit',
    input: { currentMessage: 'secret user message', request: { candidateIds: ['candidate-secret'] } },
    ...(contextBudget === undefined ? {} : { contextBudget })
  };
}

function decisionRequest(): DecisionRequest {
  return {
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.8,
    candidates: [{ candidateId: 'budget.update', priority: 1, specificity: 1, description: '更新预算' }]
  };
}

function decisionResult(): DecisionResult {
  return {
    schemaVersion: 'iar.decision/v1',
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    status: 'choice',
    choice: 'budget.update',
    score: 0.95,
    reasonCode: 'intent_match',
    candidateIds: ['budget.update']
  };
}

function longContext(): BehaviorContext {
  const context = createInitialContext('run-budget-adapter');
  context.conversationTurns = {
    turns: Array.from({ length: 64 }, (_, index) => ({
      turnId: `turn-${index}`,
      sequence: index + 1,
      userText: `old-turn-${index} ${'历史轮次 '.repeat(28)}`,
      assistantText: `old-answer-${index} ${'历史回复 '.repeat(28)}`,
      outcome: 'completed' as const,
      actionTaken: false,
      completedAt: '2026-10-26T00:00:00.000Z'
    })),
    focusTurnId: 'turn-63'
  };
  return context;
}

function intentProfile() {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId: 'function-primary',
    profileVersion: '1.0.0',
    role: 'function.select' as const,
    decisionBackend: 'intent-model' as const,
    provider: 'intent-provider',
    modelId: 'intent-model',
    modelVersion: 'intent-v1',
    timeoutMs: 100,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] },
    structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' as const }
  };
}

function semanticProfile() {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId: 'semantic-primary',
    profileVersion: '1.0.0',
    role: 'semantic.extract' as const,
    provider: 'brain-provider',
    modelId: 'semantic-model',
    modelVersion: 'semantic-v1',
    timeoutMs: 100,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] as const },
    structuredOutput: { enabled: true, schemaId: 'iar.semantic-frame/v2' as const }
  };
}

class PromptProbeProvider extends OpenAICompatibleModelProvider {
  public buildForTest(request: ModelProviderRequest): unknown {
    return this.buildPrompt(request);
  }
}

test('ModelGateway audit exposes bounded context budget diagnostics without raw input', async () => {
  const provider: ModelProvider = { complete: async () => ({ ok: true }) };
  const result = await new ModelGateway({ registry: new ModelProfileRegistry([profile()]), providers: { 'intent-provider': provider } }).invoke(
    'function.select',
    invocation(diagnostics(true)),
    () => ({ ok: true, value: { ok: true } as unknown as JsonValue })
  );

  assert.equal(result.ok, true);
  const metadata = result.audit[0]?.metadata as Record<string, unknown>;
  assert.deepEqual(metadata.contextBudget, {
    budgetChars: 24_000,
    measuredChars: 23_000,
    truncated: true,
    retained: { factHistory: 3, recentMessages: 2 }
  });
  assert.equal(JSON.stringify(metadata).includes('secret user message'), false);
  assert.equal(JSON.stringify(metadata).includes('candidate-secret'), false);
  assert.equal(JSON.stringify(metadata).includes('systemPrompt'), false);
});

test('audit observer failure does not change the model result or budget metadata', async () => {
  let observed: Record<string, unknown> | undefined;
  const provider: ModelProvider = { complete: async () => ({ ok: true }) };
  const result = await new ModelGateway({
    registry: new ModelProfileRegistry([profile()]),
    providers: { 'intent-provider': provider },
    onAudit: (audit) => { observed = audit.metadata as Record<string, unknown>; throw new Error('observer failure'); }
  }).invoke('function.select', invocation(diagnostics(false)), () => ({ ok: true, value: { ok: true } as unknown as JsonValue }));

  assert.equal(result.ok, true);
  assert.deepEqual(observed?.contextBudget, diagnostics(false));
});

test('malformed provider budget diagnostics are dropped without changing the model result', async () => {
  const provider: ModelProvider = {
    complete: async (request) => {
      request.onContextBudget?.({ retained: undefined } as unknown as ContextBudgetDiagnostics);
      return { ok: true };
    }
  };
  const result = await new ModelGateway({ registry: new ModelProfileRegistry([profile()]), providers: { 'intent-provider': provider } }).invoke(
    'function.select',
    invocation(),
    () => ({ ok: true, value: { ok: true } as unknown as JsonValue })
  );

  assert.equal(result.ok, true);
  assert.equal('contextBudget' in (result.audit[0]?.metadata as Record<string, JsonValue>), false);
});

test('semantic provider reports the actual bounded prompt diagnostics without exposing prompt text', () => {
  let observed: ContextBudgetDiagnostics | undefined;
  const prompt = new PromptProbeProvider({ endpointEnv: 'TEST_ENDPOINT', apiKeyEnv: 'TEST_API_KEY', modelIdEnv: 'TEST_MODEL', apiKey: 'test-key', baseUrl: 'https://example.invalid', modelId: 'test-model' }).buildForTest({
    traceId: 'trace-semantic-budget',
    runId: 'run-semantic-budget',
    profile: semanticProfile(),
    input: {
      text: '当前问题：预算改成 80000',
      behaviorContext: longContext(),
      recentMessages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `old-message-${index} ${'最近原文 '.repeat(40)}` })),
      pluginDescriptors: [{ functionId: 'budget.update', pluginId: 'budget', description: '更新预算', actionTypes: ['update'] }]
    },
    attempt: 1,
    signal: new AbortController().signal,
    onContextBudget: (diagnostics) => { observed = diagnostics; }
  });

  assert.ok(prompt);
  assert.ok(observed);
  assert.equal(observed?.budgetChars, INTENT_CONTEXT_BUDGET_CHARS);
  assert.equal(observed?.truncated, true);
  assert.ok((observed?.measuredChars ?? Number.POSITIVE_INFINITY) <= INTENT_CONTEXT_BUDGET_CHARS);
  assert.equal(JSON.stringify(observed).includes('old-message-0'), false);
  assert.equal(JSON.stringify(observed).includes('old-turn-0'), false);
});

test('Intent Model adapter records actual truncated context diagnostics and keeps provider input bounded', async () => {
  let observedInput: JsonValue | undefined;
  const provider: ModelProvider = {
    complete: async (request) => {
      observedInput = request.input as JsonValue;
      return decisionResult();
    }
  };
  const result = await new IntentModelDecisionAdapter(
    new ModelGateway({ registry: new ModelProfileRegistry([intentProfile()]), providers: { 'intent-provider': provider } }),
    'function.select'
  ).decide({
    traceId: 'trace-budget-adapter',
    runId: 'run-budget-adapter',
    request: decisionRequest(),
    currentMessage: '当前问题：预算改成 80000',
    behaviorContext: longContext(),
    recentMessages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `old-message-${index} ${'最近原文 '.repeat(40)}` }))
  });

  assert.equal(result.ok, true);
  assert.ok(observedInput);
  assert.ok(JSON.stringify(observedInput).length <= INTENT_CONTEXT_BUDGET_CHARS);
  const metadata = result.audit[0]?.metadata as Record<string, JsonValue>;
  const contextBudget = metadata.contextBudget as Record<string, JsonValue>;
  assert.equal(contextBudget.budgetChars, INTENT_CONTEXT_BUDGET_CHARS);
  assert.equal(contextBudget.truncated, true);
  assert.ok(typeof contextBudget.measuredChars === 'number' && contextBudget.measuredChars <= INTENT_CONTEXT_BUDGET_CHARS);
  assert.equal(typeof (contextBudget.retained as Record<string, JsonValue>).conversationTurns, 'number');
});

test('Intent Model adapter rejects an over-budget required request before provider and audit', async () => {
  let providerCalls = 0;
  const request = decisionRequest();
  request.candidates = Array.from({ length: 128 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    priority: 1,
    specificity: 1,
    description: '候选描述 '.repeat(40)
  }));
  const result = await new IntentModelDecisionAdapter(
    new ModelGateway({
      registry: new ModelProfileRegistry([intentProfile()]),
      providers: { 'intent-provider': { complete: async () => { providerCalls += 1; return decisionResult(); } } }
    }),
    'function.select'
  ).decide({ traceId: 'trace-budget-failure', runId: 'run-budget-failure', request, currentMessage: '当前问题' });

  assert.equal(result.ok, false);
  assert.equal(providerCalls, 0);
  assert.deepEqual(result.ok ? undefined : result.error, {
    code: 'model.invalid_request',
    message: 'Intent Model decision request 无效',
    retryable: false,
    details: {}
  });
  assert.deepEqual(result.audit, []);
  assert.deepEqual(result.events, []);
});

