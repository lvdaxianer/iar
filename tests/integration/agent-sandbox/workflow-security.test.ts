import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type CollectionState } from '@iar/contracts';
import { classifySessionWorkflowDecision, recoverContinuation } from '../../../examples/agent-sandbox/src/session-clarification.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import type { PluginDescriptor } from '@iar/plugins';
import { createInitialContext, type SemanticFrame } from '@iar/runtime';

test('illegal model event cannot jump from parameter collection to execution', () => {
  const context = createInitialContext('workflow-security');
  context.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };
  context.pending = { kind: 'slot', status: 'required' };
  context.collection = {
    kind: 'parameters', functionId: 'verified.function', pluginId: 'verified.plugin', schemaVersion: 'schema-v1',
    collected: {}, missingFields: ['value'], invalidFields: [], conflictFields: [], attempt: 1
  };
  const disposition = classifySessionWorkflowDecision(context, {
    schemaVersion: SCHEMA_VERSIONS.workflowDecision,
    userIntent: 'confirm', event: 'confirmation_accepted'
  });
  assert.deepEqual(disposition, { kind: 'invalid', reasonCode: 'workflow_transition_invalid', event: 'confirmation_accepted' });
});

test('continuation recovery ignores model-created Function and Plugin identifiers', () => {
  const context = createInitialContext('forged-route');
  context.route = { functionId: 'verified.function', pluginId: 'verified.plugin' };
  context.collection = {
    kind: 'parameters', functionId: 'verified.function', pluginId: 'verified.plugin', schemaVersion: 'schema-v1',
    collected: {}, missingFields: ['value'], invalidFields: [], conflictFields: [], attempt: 1
  };
  const descriptor = { functionId: 'verified.function', pluginId: 'verified.plugin', actionTypes: ['update'], operationMetadata: { operations: [] } } as unknown as PluginDescriptor;
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'model.created.function', pluginId: 'model.created.plugin', action: 'update', slots: {}, references: [], confidence: 0.99,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'provide_parameter', event: 'parameter_received' }
  };
  const recovered = recoverContinuation([descriptor], context, frame, '补充参数');
  assert.equal(recovered.functionId, 'verified.function');
  assert.equal(recovered.pluginId, 'verified.plugin');
  assert.equal(recovered.frame.intent, 'verified.function');
  assert.equal(recovered.frame.pluginId, 'verified.plugin');
});

test('ordinary and streamed high-risk turns wait for confirmation before execution', async () => {
  const normal = new IarSandboxSession({ mode: 'scripted' });
  const streamed = new IarSandboxSession({ mode: 'scripted' });
  try {
    const normalResult = await normal.turn('帮我创建工单');
    const streamedResult = await streamed.turnStreamed('帮我创建工单', () => undefined);
    for (const result of [normalResult, streamedResult]) {
      assert.equal(result.status, 'awaiting_confirmation');
      assert.equal('actionResult' in result, false);
      assert.ok(result.pending.actionId.length > 0);
    }
    assert.equal((await normal.state()).pending?.actionId, normalResult.status === 'awaiting_confirmation' ? normalResult.pending.actionId : undefined);
    assert.equal((await streamed.state()).pending?.actionId, streamedResult.status === 'awaiting_confirmation' ? streamedResult.pending.actionId : undefined);
  } finally {
    normal.dispose();
    streamed.dispose();
  }
});

test('parameter collection security state remains bounded and cannot be promoted by a forged target', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const collection: Extract<CollectionState, { kind: 'parameters' }> = {
      kind: 'parameters', functionId: 'missing.function', pluginId: 'missing.plugin', schemaVersion: 'iar.function/v1',
      collected: { operation: 'read' }, missingFields: ['value'], invalidFields: [], conflictFields: [], attempt: 1
    };
    await session.updateParameterCollection(collection);
    const result = await session.turn('继续补充');
    assert.notEqual(result.status, 'executed');
    assert.equal(result.route.functionId, 'missing.function');
    assert.equal(result.route.pluginId, 'missing.plugin');
  } finally {
    session.dispose();
  }
});
