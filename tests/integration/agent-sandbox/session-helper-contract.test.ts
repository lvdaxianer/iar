import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginOperation } from '@iar/contracts';
import { buildActionInput, buildFunctionCallInput } from '../../../examples/agent-sandbox/src/session-helpers.js';

const limitOperation: PluginOperation = { name: 'limit', kind: 'action', description: '调整限流阈值' };

test('action input reports a stable operation_missing reason when the model frame omits operation', () => {
  const result = buildActionInput('api.gateway', { target: 'order-center' }, '把订单接口限流调到 50 次', 'update', undefined, [limitOperation]);
  assert.deepEqual(result, { missing: ['operation'], reasonCode: 'operation_missing' });
});

test('function-call input reports operation_conflict instead of pretending operation is missing', () => {
  const result = buildFunctionCallInput({
    schemaVersion: 'iar.function-call/v1',
    pluginId: 'api-gateway-v1',
    functionId: 'api.gateway',
    operation: 'limit',
    arguments: { operation: 'stats', target: 'order-center', limit: 50 },
    confidence: 0.99
  });
  assert.deepEqual(result, {
    reasonCode: 'operation_conflict',
    expectedOperation: 'limit',
    actualOperation: 'stats'
  });
});

test('function-call input injects the outer operation when arguments contain only business fields', () => {
  const result = buildFunctionCallInput({
    schemaVersion: 'iar.function-call/v1',
    pluginId: 'api-gateway-v1',
    functionId: 'api.gateway',
    operation: 'limit',
    arguments: { target: 'order-center', limit: 50 },
    confidence: 0.99
  });
  assert.deepEqual(result, { input: { target: 'order-center', limit: 50, operation: 'limit' } });
});
