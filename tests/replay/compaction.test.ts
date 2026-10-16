/**
 * 验证上下文压缩候选结果的 Schema、事件引用和关键状态保护。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContract } from '@iar/contracts';
import {
  ContextCompactionService,
  createInitialContext,
  type CompactionRequest,
  type CompactionResult
} from '../../packages/runtime/src/index.js';

const sourceEvent = {
  schemaVersion: 'iar.event/v1' as const,
  eventId: 'evt-source',
  eventName: 'workflow.started' as const,
  occurredAt: '2026-10-17T00:00:00.000Z',
  runId: 'run-compact',
  correlationId: 'corr-compact',
  payload: { subjectId: 'test1', intent: 'service.stop' }
};

const keptEvent = {
  schemaVersion: 'iar.event/v1' as const,
  eventId: 'evt-kept',
  eventName: 'workflow.transitioned' as const,
  occurredAt: '2026-10-17T00:00:01.000Z',
  runId: 'run-compact',
  correlationId: 'corr-compact',
  payload: { currentStep: 'await_confirmation' }
};

function buildResult(state: ReturnType<typeof createInitialContext>): CompactionResult {
  return {
    schemaVersion: 'iar.compaction-result/v1',
    summary: '用户要停止 test1，当前等待确认。',
    state: {
      subject: state.subject,
      intent: state.intent,
      action: state.action,
      route: state.route,
      slots: state.slots,
      workflow: state.workflow,
      pending: state.pending,
      confirmation: state.confirmation
    },
    references: [{ text: '第一个服务', resolvedTo: 'test1', sourceEventId: sourceEvent.eventId }],
    preservedFacts: ['subject', 'action', 'functionId', 'pluginId', 'slots', 'workflow.currentStep', 'pending', 'confirmation', 'intent', 'idempotencyKey'],
    warnings: []
  };
}

function buildRequest(result: CompactionResult, overrides: Partial<CompactionRequest> = {}): CompactionRequest {
  return {
    current: createInitialContext('run-compact'),
    runId: 'run-compact',
    correlationId: 'corr-compact',
    occurredAt: '2026-10-17T00:01:00.000Z',
    compactedEventId: 'evt-compacted',
    failureEventId: 'evt-compaction-failed',
    events: [sourceEvent, keptEvent],
    result,
    fromEventId: sourceEvent.eventId,
    toEventId: sourceEvent.eventId,
    firstKeptEntryId: keptEvent.eventId,
    beforeTokenCount: 100,
    afterTokenCount: 40,
    summaryVersion: 'summary-v1',
    generatorVersion: 'compactor-test-v1',
    ...overrides
  };
}

test('valid compaction result produces a compacted event and keeps references', () => {
  const context = createInitialContext('run-compact');
  const outcome = new ContextCompactionService().compact(buildRequest(buildResult(context)));
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.event.eventName, 'context.compacted');
    assert.equal(outcome.context.integrity.criticalFieldHash, context.integrity.criticalFieldHash);
    assert.equal(outcome.event.payload.fromEventId, sourceEvent.eventId);
    assert.notEqual(outcome.event.payload.state, outcome.context);
  }
});

test('critical state changes retain the old context and append compaction_failed', () => {
  const context = createInitialContext('run-compact');
  const candidate = structuredClone(context);
  candidate.route.pluginId = 'unexpected-plugin';
  const outcome = new ContextCompactionService().compact(buildRequest(buildResult(candidate)));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.deepEqual(outcome.context, context);
    assert.equal(outcome.failureEvent.eventName, 'context.compaction_failed');
    assert.equal(outcome.failureEvent.payload.reasonCode, 'contract.validation_failed');
  }
});

test('workflow step and confirmation scope changes are rejected', () => {
  const changes = [
    (candidate: ReturnType<typeof createInitialContext>) => { candidate.workflow.currentStep = 'unexpected-step'; },
    (candidate: ReturnType<typeof createInitialContext>) => {
      candidate.confirmation = { state: 'confirmed', scopeHash: 'unexpected-scope', confirmedAt: '2026-10-17T00:00:00.000Z' };
    }
  ];
  for (const change of changes) {
    const context = createInitialContext('run-compact');
    const candidate = structuredClone(context);
    change(candidate);
    const outcome = new ContextCompactionService().compact(buildRequest(buildResult(candidate)));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.deepEqual(outcome.context, context);
  }
});

test('unknown reference event rejects compaction without changing the old view', () => {
  const context = createInitialContext('run-compact');
  const result = buildResult(context);
  result.references[0]!.sourceEventId = 'evt-missing';
  const outcome = new ContextCompactionService().compact(buildRequest(result));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.deepEqual(outcome.context, context);
});

test('invalid requests return stable failures instead of throwing', () => {
  const context = createInitialContext('run-compact');
  const result = buildResult(context);
  const service = new ContextCompactionService();
  const invalidEvent = service.compact(buildRequest(result, { events: [null as unknown as typeof sourceEvent] }));
  assert.equal(invalidEvent.ok, false);
  const invalidContext = service.compact(buildRequest(result, { current: {} as ReturnType<typeof createInitialContext> }));
  assert.equal(invalidContext.ok, false);
});

test('duplicate output ids and incomplete preserved facts are rejected', () => {
  const context = createInitialContext('run-compact');
  const result = buildResult(context);
  result.preservedFacts = [];
  const outcome = new ContextCompactionService().compact(buildRequest(result, { compactedEventId: sourceEvent.eventId }));
  assert.equal(outcome.ok, false);
});

test('event timestamps must be monotonic and failure ids cannot collide', () => {
  const context = createInitialContext('run-compact');
  const result = buildResult(context);
  const reversed = { ...keptEvent, occurredAt: '2026-10-16T23:59:59.000Z' };
  const timestampOutcome = new ContextCompactionService().compact(buildRequest(result, { events: [sourceEvent, reversed] }));
  assert.equal(timestampOutcome.ok, false);
  const collisionOutcome = new ContextCompactionService().compact(buildRequest(result, { failureEventId: sourceEvent.eventId }));
  assert.equal(collisionOutcome.ok, false);
  if (!collisionOutcome.ok) assert.notEqual(collisionOutcome.failureEvent.eventId, sourceEvent.eventId);
});

test('context events use dedicated payload schemas', () => {
  const invalid = { ...sourceEvent, eventName: 'context.compacted' as const, payload: { totally: 'invalid' } };
  assert.equal(validateContract('event', invalid).ok, false);
});
