/*
 * 固化通用 workflow decision 的非权威边界和确定性状态转换。
 * 测试只使用通用状态与事件，不引用任何业务 Function、Plugin 或关键词。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA_VERSIONS, validateContract, type WorkflowDecision } from '@iar/contracts';
import { transitionWorkflow, type WorkflowPhase } from '@iar/runtime';

function decision(overrides: Partial<WorkflowDecision> = {}): WorkflowDecision {
  return {
    schemaVersion: SCHEMA_VERSIONS.workflowDecision,
    userIntent: 'provide_parameter',
    event: 'parameter_received',
    ...overrides
  };
}

test('workflow decision is versioned, bounded, and non-authoritative', () => {
  const valid = decision();
  assert.equal(validateContract('workflowDecision', valid).ok, true);

  const forged = validateContract('workflowDecision', {
    ...valid,
    functionId: 'model-created-function',
    pluginId: 'model-created-plugin',
    nextState: 'executing'
  });
  assert.equal(forged.ok, false);
});

test('parameter collection accepts parameter events but rejects execution jumps', () => {
  const current: WorkflowPhase = 'collecting_parameters';
  const accepted = transitionWorkflow(current, decision());
  assert.deepEqual(accepted, { ok: true, currentState: current, nextState: current, event: 'parameter_received' });

  const rejected = transitionWorkflow(current, decision({ userIntent: 'confirm', event: 'confirmation_accepted' }));
  assert.deepEqual(rejected, { ok: false, reasonCode: 'workflow_transition_invalid', currentState: current, event: 'confirmation_accepted' });
});

test('cancellation clears the executable workflow path without executing', () => {
  const result = transitionWorkflow('awaiting_confirmation', decision({ userIntent: 'cancel_workflow', event: 'workflow_cancelled' }));
  assert.deepEqual(result, { ok: true, currentState: 'awaiting_confirmation', nextState: 'cancelled', event: 'workflow_cancelled' });
});

test('completed workflow can accept a new bounded input without granting execution', () => {
  const result = transitionWorkflow('completed', decision({ userIntent: 'provide_parameter', event: 'parameter_received' }));
  assert.deepEqual(result, { ok: true, currentState: 'completed', nextState: 'collecting_parameters', event: 'parameter_received' });
});

test('unknown runtime state fails closed instead of indexing the transition table', () => {
  const result = transitionWorkflow('untrusted_state' as WorkflowPhase, decision());
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'workflow_transition_invalid');
});
