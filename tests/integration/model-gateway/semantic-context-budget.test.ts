import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_CONTEXT_BUDGET_CHARS, createInitialContext } from '@iar/runtime';
import type { BehaviorContext } from '@iar/contracts';
import { buildSemanticUserPrompt } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';

function longContext(): BehaviorContext {
  const context = createInitialContext('run-long-semantic-context');
  context.conversationTurns = {
    turns: Array.from({ length: 64 }, (_, index) => ({
      turnId: `turn-${index}`,
      sequence: index + 1,
      runId: 'run-long-semantic-context',
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
      values: { value: `old-fact-${index} ${'历史事实 '.repeat(25)}` },
      createdAt: '2026-10-26T00:00:00.000Z'
    })) as never,
    focusRecordId: 'fact-63'
  };
  return context;
}

test('semantic prompt stays within the shared budget while keeping current input and newest facts', () => {
  const prompt = buildSemanticUserPrompt({
    text: '当前覆盖参数：预算改成 80000',
    behaviorContext: longContext(),
    recentMessages: Array.from({ length: 20 }, (_, index) => ({ role: 'user', text: `old-message-${index} ${'最近原文 '.repeat(60)}` })),
    pluginDescriptors: [{ functionId: 'function.lookup', pluginId: 'plugin.lookup', description: '查询能力', actionTypes: ['query'] }]
  });

  assert.ok(prompt.length <= INTENT_CONTEXT_BUDGET_CHARS);
  assert.match(prompt, /当前覆盖参数：预算改成 80000/);
  assert.match(prompt, /old-fact-63/);
  assert.doesNotMatch(prompt, /old-turn-0|old-message-0|old-fact-0/);
  assert.match(prompt, /<conversation_turns>/);
  assert.match(prompt, /<fact_history>/);
});
