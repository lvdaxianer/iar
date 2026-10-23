import assert from 'node:assert/strict';
import test from 'node:test';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from '@iar/runtime';
import { SCHEMA_VERSIONS, validateContract, type BehaviorContext, type CollectionState, type EventEnvelope } from '@iar/contracts';
import { summarizeParameterValidation } from '../../../examples/agent-sandbox/src/collection-types.js';

const schema = {
  type: 'object',
  properties: {
    target: { type: 'string', minLength: 1 },
    priority: { type: 'string', enum: ['low', 'high'] },
    enabled: { type: 'boolean' }
  },
  required: ['target', 'priority'],
  additionalProperties: false
};

function withCollection(collection: CollectionState): BehaviorContext {
  const context = createInitialContext('collection-contract');
  context.collection = collection;
  context.integrity.criticalFieldHash = criticalFieldHash(context);
  return context;
}

test('BehaviorContext accepts bounded function and parameter collection states', () => {
  const functionCollection = withCollection({
    kind: 'function',
    pluginId: 'plugin.synthetic',
    candidateFunctionIds: ['function.synthetic.one', 'function.synthetic.two'],
    candidateKeys: ['plugin.synthetic:function.synthetic.one', 'plugin.synthetic:function.synthetic.two'],
    reasonCode: 'function_ambiguous',
    attempt: 1
  });
  const functionResult = validateContract('behaviorContext', functionCollection);
  assert.equal(functionResult.ok, true);

  const parameterCollection = withCollection({
    kind: 'parameters',
    functionId: 'function.synthetic',
    pluginId: 'plugin.synthetic',
    schemaVersion: 'synthetic/v1',
    collected: { target: 'resource-a' },
    missingFields: ['priority'],
    invalidFields: [],
    conflictFields: [],
    attempt: 1
  });
  assert.equal(parameterCollection.collection?.kind, 'parameters');
  assert.deepEqual(parameterCollection.collection?.missingFields, ['priority']);
});

test('parameter validation summary reports schema fields without business rules', () => {
  const summary = summarizeParameterValidation(schema, { target: 'resource-a', priority: 'urgent', unexpected: true }, ['target']);
  assert.deepEqual(summary.expectedFields, ['target', 'priority', 'enabled']);
  assert.deepEqual(summary.presentFields, ['target', 'priority', 'unexpected']);
  assert.deepEqual(summary.missingFields, []);
  assert.deepEqual(summary.invalidFields, ['priority', 'unexpected']);
  assert.deepEqual(summary.conflictFields, ['target']);
  assert.equal(summary.valid, false);
});

test('collection contract rejects unbounded candidates and values', () => {
  const context = withCollection({
    kind: 'function',
    candidateFunctionIds: Array.from({ length: 13 }, (_, index) => `function.synthetic.${index}`),
    reasonCode: 'function_ambiguous',
    attempt: 1
  });
  const result = validateContract('behaviorContext', context);
  assert.equal(result.ok, false);
});

test('collection state survives clarification event projection and can be cleared', () => {
  const projector = new BehaviorContextProjector();
  const collection: CollectionState = {
    kind: 'function', candidateFunctionIds: ['function.synthetic'], candidateKeys: ['plugin.synthetic:function.synthetic'], reasonCode: 'function_missing', attempt: 1
  };
  const event: EventEnvelope = {
    schemaVersion: SCHEMA_VERSIONS.event, eventId: 'collection-event', eventName: 'context.clarification.updated', occurredAt: '2026-10-23T00:00:00.000Z', runId: 'collection-run', correlationId: 'collection-correlation',
    payload: { pending: { kind: 'selection', status: 'required', options: [{ key: 'plugin.synthetic:function.synthetic', label: 'Synthetic capability' }] }, collection }
  };
  projector.apply(event);
  assert.deepEqual(projector.current().collection, collection);
  projector.apply({ ...event, eventId: 'collection-clear', occurredAt: '2026-10-23T00:00:01.000Z', payload: { pending: { kind: 'input', status: 'none' }, collection: null } });
  assert.equal(projector.current().collection, undefined);
});
