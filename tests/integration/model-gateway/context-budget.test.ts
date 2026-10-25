import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENT_CONTEXT_BUDGET_CHARS,
  IntentContextBudgetError,
  assembleIntentContext,
  type ContextBudgetSection
} from '@iar/runtime';

function section(name: string, value: unknown, priority: 'required' | 'optional', itemized = false, path?: string[]): ContextBudgetSection {
  return { name, value: value as never, priority, itemized, ...(path === undefined ? {} : { path }) };
}

test('keeps required intent layers and removes old optional items within one total budget', () => {
  const result = assembleIntentContext({
    budgetChars: 900,
    sections: [
      section('currentMessage', '把预算改成 80000', 'required'),
      section('workflowContext', { currentState: 'waiting', pending: { kind: 'slot' } }, 'required'),
      section('candidateBoundary', { candidateIds: ['budget.update'], descriptions: ['更新预算'] }, 'required'),
      section('structuredContext', { slots: { budget: { value: 50_000, status: 'resolved' } } }, 'required'),
      section('behaviorContext', { workflow: { currentStep: 'collect', status: 'waiting' } }, 'required'),
      section('summary', '旧摘要 '.repeat(100), 'optional'),
      section('factHistory', [
        { sequence: 1, values: { budget: 10_000, note: '旧事实 '.repeat(40) } },
        { sequence: 2, values: { budget: 50_000, note: '中间事实 '.repeat(40) } },
        { sequence: 3, values: { budget: 80_000 } }
      ], 'optional', true, ['behaviorContext', 'factHistory']),
      section('recentMessages', [
        { role: 'user', text: '非常旧的消息 '.repeat(30) },
        { role: 'user', text: '最近的消息' }
      ], 'optional', true),
      section('conversationTurns', [
        { sequence: 1, userText: '旧轮次 '.repeat(40), assistantText: '旧回复' },
        { sequence: 2, userText: '最新轮次', assistantText: '最新回复' }
      ], 'optional', true)
    ]
  });

  assert.ok(result.diagnostics.truncated);
  assert.equal(result.diagnostics.budgetChars, 900);
  assert.ok(result.diagnostics.measuredChars <= result.diagnostics.budgetChars);
  assert.deepEqual(result.context.currentMessage, '把预算改成 80000');
  assert.deepEqual(result.context.workflowContext, { currentState: 'waiting', pending: { kind: 'slot' } });
  assert.deepEqual(result.context.candidateBoundary, { candidateIds: ['budget.update'], descriptions: ['更新预算'] });
  const behaviorContext = result.context.behaviorContext as Record<string, unknown>;
  assert.deepEqual(behaviorContext.factHistory, [{ sequence: 3, values: { budget: 80_000 } }]);
  assert.deepEqual(result.context.recentMessages, [{ role: 'user', text: '最近的消息' }]);
  assert.equal(JSON.parse(result.serialized).currentMessage, '把预算改成 80000');
  assert.doesNotMatch(JSON.stringify(result.diagnostics), /80000|预算/);
});
test('uses the default total character budget and exposes only bounded diagnostics', () => {
  const result = assembleIntentContext({
    sections: [section('currentMessage', '查询状态', 'required')]
  });

  assert.equal(INTENT_CONTEXT_BUDGET_CHARS, 24_000);
  assert.equal(result.diagnostics.budgetChars, INTENT_CONTEXT_BUDGET_CHARS);
  assert.equal(result.diagnostics.truncated, false);
  assert.deepEqual(result.diagnostics.retained, {});
  assert.equal(result.serialized, JSON.stringify(result.context));
});

test('fails closed when required layers alone exceed the budget', () => {
  const candidateBoundary = { candidateIds: ['candidate.keep'], description: '保留候选' };
  assert.throws(
    () => assembleIntentContext({
      budgetChars: 100,
      sections: [
        section('currentMessage', '当前问题', 'required'),
        section('candidateBoundary', candidateBoundary, 'required'),
        section('workflowContext', { state: 'x'.repeat(200) }, 'required')
      ]
    }),
    (error: unknown) => {
      if (!(error instanceof IntentContextBudgetError)) return false;
      assert.equal(error.code, 'intent.context_budget_exceeded');
      assert.equal(error.message, 'Intent context exceeds the configured character budget');
      return true;
    }
  );
});
