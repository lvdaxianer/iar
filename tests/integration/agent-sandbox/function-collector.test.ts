import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFunctionCandidates } from '../../../examples/agent-sandbox/src/function-collector.js';
import type { PluginDescriptor } from '@iar/plugins';

const descriptors: PluginDescriptor[] = [
  descriptor('plugin.alpha', 'function.read', '读取资源'),
  descriptor('plugin.alpha', 'function.write', '写入资源'),
  descriptor('plugin.beta', 'function.read', '读取另一类资源')
];

function descriptor(pluginId: string, functionId: string, description: string): PluginDescriptor {
  return {
    candidateKey: `${pluginId}:${functionId}`,
    pluginId,
    functionId,
    description,
    actionTypes: ['query'],
    capabilities: ['resource.read'],
    operationMetadata: { actionTypes: ['query'], capabilities: ['resource.read'], riskLevel: 'low', requiresConfirmation: false, operations: [] }
  };
}

test('selected Plugin without Function creates a bounded Function collection', () => {
  const result = collectFunctionCandidates(descriptors, { pluginId: 'plugin.alpha', attempt: 1 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.candidateFunctionIds, ['function.read', 'function.write']);
  assert.deepEqual(result.state.candidateKeys, ['plugin.alpha:function.read', 'plugin.alpha:function.write']);
  assert.deepEqual(result.options.map((option) => option.key), result.state.candidateKeys);
});

test('same Function across Plugins keeps opaque candidate keys', () => {
  const result = collectFunctionCandidates(descriptors, { functionId: 'function.read', attempt: 1 });
  assert.equal(result.status, 'collecting');
  if (result.status !== 'collecting') return;
  assert.deepEqual(result.state.candidateFunctionIds, ['function.read']);
  assert.deepEqual(result.state.candidateKeys, ['plugin.alpha:function.read', 'plugin.beta:function.read']);
  assert.equal(result.state.reasonCode, 'function_ambiguous');
});

test('unique Function is selected deterministically without asking the user', () => {
  const result = collectFunctionCandidates(descriptors, { pluginId: 'plugin.beta', attempt: 1 });
  assert.equal(result.status, 'selected');
  if (result.status !== 'selected') return;
  assert.equal(result.descriptor.functionId, 'function.read');
  assert.equal(result.descriptor.pluginId, 'plugin.beta');
});

test('unknown registry scope returns a stable empty result', () => {
  const result = collectFunctionCandidates(descriptors, { pluginId: 'plugin.missing', attempt: 1 });
  assert.deepEqual(result, { status: 'empty', reasonCode: 'function_candidates_empty' });
});
