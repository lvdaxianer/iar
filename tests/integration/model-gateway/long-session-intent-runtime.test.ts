import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionResult, JsonValue } from '@iar/contracts';
import { INTENT_CONTEXT_BUDGET_CHARS, IntentModelDecisionAdapter, ModelGateway, ModelProviderError, ModelProfileRegistry, createInitialContext, type DecisionRequest, type ModelProvider } from '@iar/runtime';
import { buildSemanticUserPromptWithBudget } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

function decisionRequest(): DecisionRequest {
  return {
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.8,
    candidates: [{ candidateId: 'api.gateway', priority: 1, specificity: 1, description: '调整网关限流配额' }]
  };
}

function decisionResult(): DecisionResult {
  return {
    schemaVersion: 'iar.decision/v1',
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    status: 'choice',
    choice: 'api.gateway',
    score: 0.99,
    reasonCode: 'intent_match',
    candidateIds: ['api.gateway']
  };
}

function intentProfile(profileId: string, fallbackProfileId?: string) {
  return {
    schemaVersion: 'iar.model-profile/v1' as const,
    profileId,
    profileVersion: '1.0.0',
    role: 'function.select' as const,
    decisionBackend: 'intent-model' as const,
    provider: `${profileId}-provider`,
    modelId: `${profileId}-model`,
    modelVersion: `${profileId}-v1`,
    timeoutMs: 100,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['provider_failed'] as const },
    ...(fallbackProfileId === undefined ? {} : { fallbackProfileId }),
    structuredOutput: { enabled: true, schemaId: 'iar.decision/v1' as const }
  };
}

test('20-plus-turn session preserves relative follow-up, current override, bounded prompt, and fail-closed context', async () => {
  const session = new IarSandboxSession({ mode: 'scripted', decisionBackend: 'intent-model' });
  try {
    const warmupMessages = ['请重新查询系统状态', '请重新查询退款政策', '请重新查看网关统计', '请重新列出今天的集成任务'];
    for (let index = 0; index < 20; index += 1) {
      const result = await session.turn(warmupMessages[index % warmupMessages.length]!);
      assert.notEqual(result.status, 'failed');
    }

    const initial = await session.turn('把订单接口的限流值调整到每秒 50 次');
    assert.equal(initial.status, 'awaiting_confirmation');
    assert.equal((await session.confirm(true)).status, 'executed');

    const override = await session.turn('把订单接口的限流改成每秒200次吧');
    assert.equal(override.status, 'awaiting_confirmation');
    assert.equal(override.route.functionId, 'api.gateway');
    if (override.status !== 'awaiting_confirmation') return;
    assert.deepEqual(override.pending.input, {
      operation: 'limit',
      query: '把订单接口的限流改成每秒200次吧',
      params: { receipt: 'gateway-limit-order-center', target: 'order-center' }
    });
    assert.equal((await session.confirm(true)).status, 'executed');

    const list = await session.turn('列出今天的集成任务');
    assert.equal(list.status, 'executed');
    const relative = await session.turn('这个列表里第一个任务的名字');
    assert.equal(relative.status, 'clarification');
    assert.match(relative.reply, /第一个任务的名称/);

    const state = await session.state();
    const turns = state.context.conversationTurns?.turns ?? [];
    assert.ok(turns.length >= 23 && turns.length <= 40);
    assert.equal(turns.at(-1)?.userText, '这个列表里第一个任务的名字');

    const budgeted = buildSemanticUserPromptWithBudget({
      text: '把订单接口的限流改成每秒200次吧',
      behaviorContext: state.context,
      recentMessages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `old-message-${index} ${'较早的消息 '.repeat(160)}` })),
      pluginDescriptors: [{ functionId: 'api.gateway', pluginId: 'api-gateway-v1', description: '网关限流管理', actionTypes: ['update'] }]
    });
    assert.ok(budgeted.prompt.length <= INTENT_CONTEXT_BUDGET_CHARS);
    assert.equal(budgeted.diagnostics.truncated, true);
    assert.match(budgeted.prompt, /把订单接口的限流改成每秒200次吧/);
    assert.doesNotMatch(budgeted.prompt, /old-message-0/);
  } finally {
    session.dispose();
  }
});

test('long-session Intent Model fallback keeps bounded context diagnostics on both attempts', async () => {
  const context = createInitialContext('run-long-session-fallback');
  context.conversationTurns = {
    turns: Array.from({ length: 32 }, (_, index) => ({
      turnId: `turn-${index + 1}`,
      sequence: index + 1,
      userText: `旧参数：每秒 ${50 + index} 次 ${'历史输入 '.repeat(25)}`,
      assistantText: `已记录旧参数 ${'历史回复 '.repeat(25)}`,
      outcome: 'completed' as const,
      actionTaken: false,
      completedAt: '2026-10-26T00:00:00.000Z'
    }))
  };
  const primary = intentProfile('long-primary', 'long-fallback');
  const fallback = intentProfile('long-fallback');
  const providers: Record<string, ModelProvider> = {
    'long-primary-provider': { complete: async () => { throw new ModelProviderError('provider_failed'); } },
    'long-fallback-provider': { complete: async () => decisionResult() }
  };
  const result = await new IntentModelDecisionAdapter(
    new ModelGateway({ registry: new ModelProfileRegistry([primary, fallback]), providers }),
    'function.select'
  ).decide({
    traceId: 'trace-long-session-fallback',
    runId: 'run-long-session-fallback',
    request: decisionRequest(),
    currentMessage: '改成每秒 200 次吧',
    behaviorContext: context,
    recentMessages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `旧消息 ${index} ${'历史消息 '.repeat(120)}` }))
  });

  assert.equal(result.ok, true);
  assert.equal(result.audit.length, 2);
  assert.deepEqual(result.audit.map((entry) => ({ profileId: entry.profileId, fallbackUsed: entry.fallbackUsed, outcome: entry.outcome })), [
    { profileId: primary.profileId, fallbackUsed: false, outcome: 'provider_failed' },
    { profileId: fallback.profileId, fallbackUsed: true, outcome: 'success' }
  ]);
  for (const entry of result.audit) {
    const metadata = entry.metadata as Record<string, JsonValue>;
    const budget = metadata.contextBudget as Record<string, JsonValue>;
    assert.equal(budget.budgetChars, INTENT_CONTEXT_BUDGET_CHARS);
    assert.equal(budget.truncated, true);
    assert.ok(typeof budget.measuredChars === 'number' && budget.measuredChars <= INTENT_CONTEXT_BUDGET_CHARS);
  }
});
