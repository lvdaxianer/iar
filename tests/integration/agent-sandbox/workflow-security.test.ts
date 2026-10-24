import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, type CollectionState } from '@iar/contracts';
import { classifySessionWorkflowDecision, normalizeContextFollowUpFrame, normalizeCurrentTurnWorkflowDecision, recoverContinuation } from '../../../examples/agent-sandbox/src/session-clarification.js';
import { constrainFrame } from '../../../examples/agent-sandbox/src/session-routing.js';
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

test('completed workflow does not reject a fact follow-up with an incompatible model event', () => {
  const context = createInitialContext('completed-follow-up');
  context.workflow = { currentStep: 'completed', status: 'completed' };
  context.action = { name: 'ticket.create', status: 'resolved' };
  context.factHistory = {
    records: [{
      recordId: 'fact-001', sequence: 1, sourceEventId: 'event-001',
      functionId: 'verified.function', pluginId: 'verified.plugin',
      values: { ticketId: 'ticket-001' }, createdAt: '2026-10-20T00:00:00.000Z'
    }],
    focusRecordId: 'fact-001'
  };
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'ticket.read', action: 'query', slots: {}, references: [], confidence: 0.93,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'confirm', event: 'confirmation_accepted' }
  };

  const normalized = normalizeContextFollowUpFrame(context, frame, '刚才那张工单的编号是多少？');
  assert.equal(normalized.intent, 'unknown');
  assert.equal(normalized.action, 'query');
  assert.equal(normalized.pluginId, undefined);
  assert.deepEqual(normalized.workflowDecision, { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'answer_context', event: 'context_answered' });
  assert.notEqual(classifySessionWorkflowDecision(context, normalized.workflowDecision).kind, 'invalid');
});

test('explicit side-effect continuation is not downgraded to a fact query when action is unknown', () => {
  const context = createInitialContext('new-operation-after-fact');
  context.factHistory = {
    records: [{
      recordId: 'fact-001', sequence: 1, sourceEventId: 'event-001',
      functionId: 'verified.function', pluginId: 'verified.plugin',
      values: { rate: 100 }, createdAt: '2026-10-20T00:00:00.000Z'
    }],
    focusRecordId: 'fact-001'
  };
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', action: 'unknown', slots: {}, references: [], confidence: 0.2,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'provide_parameter', event: 'parameter_received' }
  };

  const normalized = normalizeContextFollowUpFrame(context, frame, '把这个改成每秒200次');
  assert.equal(normalized.intent, 'unknown');
  assert.equal(normalized.action, 'unknown');
  assert.equal(normalized.workflowDecision?.event, 'parameter_received');
});

test('stale new-topic event cannot block a current explicit Function request', () => {
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'report.export', action: 'execute', slots: { operation: 'export' }, references: [], confidence: 0.9,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'new_topic', event: 'new_topic' }
  };
  assert.equal(normalizeCurrentTurnWorkflowDecision(frame, '导出销售日报'), undefined);
  assert.equal(normalizeCurrentTurnWorkflowDecision(frame, '换个话题，导出销售日报')?.event, 'new_topic');
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

test('verified Function without Plugin resolves its unique authorized Plugin', () => {
  const context = createInitialContext('function-only-route');
  context.route = { functionId: 'verified.function' };
  const descriptor = { functionId: 'verified.function', pluginId: 'verified.plugin', actionTypes: ['update'] } as unknown as PluginDescriptor;
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', action: 'unknown', slots: {}, references: [], confidence: 0.2,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'provide_parameter', event: 'parameter_received' }
  };
  const recovered = recoverContinuation([descriptor], context, frame, '补充参数');
  assert.equal(recovered.functionId, 'verified.function');
  assert.equal(recovered.pluginId, 'verified.plugin');
  assert.equal(recovered.reasonCode, undefined);
});

test('Plugin-only continuation with multiple Functions returns candidates for clarification', () => {
  const context = createInitialContext('plugin-only-route');
  context.route = { pluginId: 'verified.plugin' };
  const descriptors = [
    { functionId: 'verified.first', pluginId: 'verified.plugin', actionTypes: ['query'] },
    { functionId: 'verified.second', pluginId: 'verified.plugin', actionTypes: ['query'] }
  ] as unknown as PluginDescriptor[];
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'unknown', action: 'unknown', slots: {}, references: [], confidence: 0.2,
    workflowDecision: { schemaVersion: SCHEMA_VERSIONS.workflowDecision, userIntent: 'select_function', event: 'function_selected' }
  };
  const recovered = recoverContinuation(descriptors, context, frame, '选择一个功能');
  assert.equal(recovered.reasonCode, 'function_ambiguous');
  assert.deepEqual(recovered.candidateDescriptors?.map((item) => item.functionId), ['verified.first', 'verified.second']);
});

test('ambiguous or invalid actions never default to the first descriptor action', () => {
  const descriptor = { functionId: 'verified.function', pluginId: 'verified.plugin', actionTypes: ['query', 'update'] } as unknown as PluginDescriptor;
  const frame: SemanticFrame = {
    schemaVersion: 'iar.semantic-frame/v1', intent: 'model.created.function', pluginId: 'model.created.plugin', action: 'unknown', slots: {}, references: [], confidence: 0.99
  };
  assert.equal(constrainFrame(frame, descriptor).action, 'unknown');

  const context = createInitialContext('invalid-action');
  context.route = { functionId: descriptor.functionId, pluginId: descriptor.pluginId };
  const invalidFrame = { ...frame, action: 'create' as const };
  const recovered = recoverContinuation([descriptor], context, invalidFrame, '继续');
  assert.equal(recovered.frame.action, 'unknown');
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
