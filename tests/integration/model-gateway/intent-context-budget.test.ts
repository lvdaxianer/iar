import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_CONTEXT_BUDGET_CHARS, buildIntentDecisionInput, createInitialContext } from '@iar/runtime';
import type { BehaviorContext } from '@iar/contracts';
import type { DecisionRequest } from '@iar/runtime';

function requestFixture(): DecisionRequest {
  return {
    decisionType: 'function.select',
    decisionVersion: 'runtime.v1',
    threshold: 0.8,
    candidates: [{ candidateId: 'budget.update', priority: 1, specificity: 1, description: '更新预算' }]
  };
}

function longContext(): BehaviorContext {
  const context = createInitialContext('run-long-intent-context');
  context.conversationTurns = {
    turns: Array.from({ length: 64 }, (_, index) => ({
      turnId: `turn-${index}`,
      sequence: index + 1,
      runId: 'run-long-intent-context',
      userText: `old-turn-${index} ${'历史轮次 '.repeat(35)}`,
      assistantText: `old-answer-${index} ${'历史回复 '.repeat(35)}`,
      outcome: 'completed',
      actionTaken: false
    })) as never,
    focusTurnId: 'turn-63'
  };
  context.factHistory = {
    records: Array.from({ length: 64 }, (_, index) => ({
      recordId: `fact-${index}`,
      sequence: index + 1,
      sourceEventId: `event-${index}`,
      functionId: 'function.lookup',
      values: { value: `old-fact-${index} ${'历史事实 '.repeat(60)}` },
      createdAt: '2026-10-26T00:00:00.000Z'
    })) as never,
    focusRecordId: 'fact-63'
  };
  return context;
}

test('Intent Model input stays within the shared budget while preserving structured context shape', () => {
  const input = buildIntentDecisionInput(
    requestFixture(),
    '当前覆盖参数：预算改成 80000',
    longContext(),
    Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `old-message-${index} ${'最近原文 '.repeat(60)}` }))
  );
  const serialized = JSON.stringify(input);
  assert.ok(serialized.length <= INTENT_CONTEXT_BUDGET_CHARS);
  assert.match(serialized, /当前覆盖参数：预算改成 80000/);
  assert.match(serialized, /old-fact-63/);
  assert.doesNotMatch(serialized, /old-turn-0|old-message-0|old-fact-0/);
  const record = input as Record<string, unknown>;
  const behaviorContext = record.behaviorContext as Record<string, unknown>;
  assert.ok(behaviorContext.factHistory);
  assert.ok(behaviorContext.conversationTurns);
});

test('Intent Model input fails closed when candidate boundary alone exceeds the shared budget', () => {
  const request = requestFixture();
  request.candidates = Array.from({ length: 128 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    priority: 1,
    specificity: 1,
    description: '候选描述 '.repeat(40)
  }));

  assert.throws(
    () => buildIntentDecisionInput(request, '当前问题'),
    (error: unknown) => error instanceof TypeError && error.message === 'Intent Decision request 无效：上下文超出预算'
  );
});
