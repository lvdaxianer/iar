import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import type { CollectionState } from '@iar/contracts';
import { collectParameters, parameterCollectionReply } from '../../../examples/agent-sandbox/src/parameter-collector.js';

const schema = {
  type: 'object',
  properties: {
    target: { type: 'string', minLength: 1, description: '目标对象' },
    priority: { type: 'string', enum: ['low', 'high'], description: '优先级' },
    enabled: { type: 'boolean', description: '是否启用' },
    details: { type: 'object', description: '补充信息' }
  },
  required: ['target', 'priority'],
  additionalProperties: false
};

test('parameter collector preserves valid values and exposes schema-driven missing fields', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: 'resource-a' }, attempt: 1 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.collected, { target: 'resource-a' });
  assert.deepEqual(result.state.missingFields, ['priority']);
  assert.deepEqual(result.state.invalidFields, []);
  assert.equal(result.state.presentation?.priority?.control, 'select');
  assert.equal(result.state.presentation?.enabled?.control, 'boolean');
});

test('parameter collector keeps the previous value when a later turn conflicts', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: 'resource-b', priority: 'high' }, previous: { kind: 'parameters', functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', collected: { target: 'resource-a' }, missingFields: ['priority'], invalidFields: [], conflictFields: [], attempt: 1 }, attempt: 2 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.collected, { target: 'resource-a', priority: 'high' });
  assert.deepEqual(result.state.conflictFields, ['target']);
});

test('a repeated value resolves a previously reported field conflict', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: 'resource-b', priority: 'high' }, previous: { kind: 'parameters', functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', collected: { target: 'resource-a', priority: 'high' }, missingFields: [], invalidFields: [], conflictFields: ['target'], attempt: 1 }, attempt: 2 });
  assert.deepEqual(result, { status: 'ready', input: { target: 'resource-b', priority: 'high' } });
});

test('parameter collector returns ready only after the complete schema is satisfied', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: 'resource-a', priority: 'high', enabled: true }, attempt: 1 });
  assert.deepEqual(result, { status: 'ready', input: { target: 'resource-a', priority: 'high', enabled: true } });
});

test('invalid and unknown fields are not passed through as executable parameters', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: '', priority: 'urgent', unexpected: true }, attempt: 1 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.collected, {});
  assert.deepEqual(result.state.invalidFields, ['target', 'priority', 'unexpected']);
});

test('runtime-required fields participate in collection without changing the registered schema', () => {
  const result = collectParameters({ functionId: 'function.synthetic', pluginId: 'plugin.synthetic', schemaVersion: 'iar.function/v1', schema, value: { target: 'resource-a', priority: 'high' }, requiredFields: ['operation'], attempt: 1 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.missingFields, ['operation']);
  assert.match(parameterCollectionReply(result.state), /操作（operation）/u);
});

test('session persists and clears parameter collection without granting execution', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  const collection: Extract<CollectionState, { kind: 'parameters' }> = {
    kind: 'parameters',
    functionId: 'function.synthetic',
    pluginId: 'plugin.synthetic',
    schemaVersion: 'iar.function/v1',
    collected: { target: 'resource-a' },
    missingFields: ['priority'],
    invalidFields: [],
    conflictFields: [],
    attempt: 1,
    presentation: { priority: { label: '优先级', control: 'select' } }
  };
  await session.updateParameterCollection(collection);
  const pending = await session.state();
  assert.deepEqual(pending.context.collection, collection);
  assert.deepEqual(pending.context.pending, { kind: 'slot', status: 'required' });
  assert.equal(pending.pending, null);
  await session.resetClarification();
  assert.equal((await session.state()).context.collection, undefined);
  session.dispose();
});
