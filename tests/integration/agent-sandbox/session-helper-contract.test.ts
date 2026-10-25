import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginOperation } from '@iar/contracts';
import { buildActionInput, buildFunctionCallInput } from '../../../examples/agent-sandbox/src/session-helpers.js';
import { deterministicFallbackReply } from '../../../examples/agent-sandbox/src/session-turn-helpers.js';

const limitOperation: PluginOperation = { name: 'limit', kind: 'action', description: '调整限流阈值' };
const gatewayReadOperations: PluginOperation[] = [
  { name: 'search', kind: 'read', description: '检索 API 网关知识库' },
  { name: 'stats', kind: 'read', description: '查看网关调用统计' }
];

test('action input reports a stable operation_missing reason when the model frame omits operation', () => {
  const result = buildActionInput('api.gateway', { target: 'order-center' }, '把订单接口限流调到 50 次', 'update', undefined, [limitOperation]);
  assert.deepEqual(result, { missing: ['operation'], reasonCode: 'operation_missing', expectedOperation: 'limit', actualOperation: 'missing' });
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

test('generic Function query does not inherit the first read Operation as a default', () => {
  const result = buildActionInput('api.gateway', { query: '网关这边帮我看看' }, '网关这边帮我看看', 'query', undefined, gatewayReadOperations);
  assert.deepEqual(result, {
    missing: ['operation'],
    reasonCode: 'operation_missing',
    expectedOperation: 'search|stats',
    actualOperation: 'missing'
  });
});

test('a Function with one read Operation can still complete without a redundant question', () => {
  const result = buildActionInput('knowledge.query', { query: '什么是限流' }, '什么是限流', 'query', undefined, [
    { name: 'search', kind: 'read', description: '检索知识库' }
  ]);
  assert.deepEqual(result, { input: { operation: 'search', query: '什么是限流' } });
});

test('a guessed read Operation is rejected when the current text does not identify it', () => {
  const result = buildActionInput('report.center', { operation: 'list' }, '报表那边弄一下', 'query', undefined, [
    { name: 'search', kind: 'read', description: '检索报表中心知识库，返回相关度最高的 3 条说明' },
    { name: 'list', kind: 'read', description: '列出报表中心可用的报表目录及刷新口径' }
  ]);
  assert.deepEqual(result, {
    missing: ['operation'],
    reasonCode: 'operation_missing',
    expectedOperation: 'search|list',
    actualOperation: 'missing'
  });
});

test('an Operation supported by the current text is retained without business-specific rules', () => {
  const result = buildActionInput('report.center', { operation: 'export' }, '报表导出', 'execute', undefined, [
    { name: 'search', kind: 'read', description: '检索报表中心知识库，返回相关度最高的 3 条说明' },
    { name: 'list', kind: 'read', description: '列出报表中心可用的报表目录及刷新口径' },
    { name: 'export', kind: 'action', description: '导出指定报表为 xlsx、csv 或 pdf 格式' }
  ]);
  assert.deepEqual(result, { input: { operation: 'export', query: '报表导出' } });
});

test('稳定路由失败使用固定分类回复且不交给 Response Model', () => {
  assert.match(deterministicFallbackReply('candidate_empty') ?? '', /没有匹配到可用的 Function/);
  assert.match(deterministicFallbackReply('bridge_unavailable') ?? '', /桥接当前不可用/);
  assert.match(deterministicFallbackReply('model.timeout') ?? '', /模型暂时不可用/);
  assert.equal(deterministicFallbackReply('reference_unresolved'), undefined);
});
