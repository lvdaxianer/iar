/*
 * 固化 BehaviorContext 到模型可观察 Workflow context 的有界投影。
 * 测试不允许投影携带完整参数值、凭据或未验证候选。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialContext, projectWorkflowContext } from '@iar/runtime';

test('initial behavior context projects to a normal workflow with bounded events', () => {
  const projection = projectWorkflowContext(createInitialContext('run-projection'));

  assert.equal(projection.mapVersion, 'iar.workflow-map/v1');
  assert.equal(projection.currentState, 'normal');
  assert.equal(projection.activeState, 'normal');
  assert.equal(projection.outcome, 'none');
  assert.equal(projection.workflowStatus, 'pending');
  assert.equal(projection.pending.kind, 'input');
  assert.equal(projection.allowedEvents.includes('unknown'), true);
  assert.equal(projection.route, undefined);
  assert.equal(projection.collection, undefined);
});

test('parameter collection projects only verified target and field status', () => {
  const context = createInitialContext('run-collection');
  context.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };
  context.route = { functionId: 'verified.function', pluginId: 'verified.plugin' };
  context.pending = { kind: 'slot', status: 'required' };
  context.collection = {
    kind: 'parameters',
    functionId: 'verified.function',
    pluginId: 'verified.plugin',
    schemaVersion: 'schema-v1',
    collected: { rate: 100, secret: 'must-not-leak' },
    missingFields: ['unit'],
    invalidFields: ['rate'],
    conflictFields: [],
    attempt: 1,
    presentation: { unit: { label: 'Unit', control: 'select' } }
  };

  const projection = projectWorkflowContext(context);
  assert.equal(projection.currentState, 'collecting_parameters');
  assert.deepEqual(projection.route, { functionId: 'verified.function', pluginId: 'verified.plugin' });
  assert.deepEqual(projection.collection, {
    kind: 'parameters',
    functionId: 'verified.function',
    pluginId: 'verified.plugin',
    schemaVersion: 'schema-v1',
    collectedFields: ['rate', 'secret'],
    missingFields: ['unit'],
    invalidFields: ['rate'],
    conflictFields: [],
    presentationFields: ['unit']
  });
  assert.equal(JSON.stringify(projection).includes('must-not-leak'), false);
});

test('required confirmation projects an awaiting state regardless of model text', () => {
  const context = createInitialContext('run-confirmation');
  context.workflow = { currentStep: 'custom-step', status: 'waiting' };
  context.pending = { kind: 'confirmation', status: 'required' };
  context.confirmation = { state: 'required', scopeHash: 'scope-hash' };

  const projection = projectWorkflowContext(context);
  assert.equal(projection.currentState, 'awaiting_confirmation');
  assert.deepEqual(projection.confirmation, { state: 'required' });
  assert.equal('scopeHash' in projection.confirmation, false);
});

test('completed workflow exposes a normal active state and historical outcome', () => {
  const context = createInitialContext('run-completed');
  context.workflow = { currentStep: 'completed', status: 'completed' };
  context.action = { name: 'ticket.create', status: 'resolved' };

  const projection = projectWorkflowContext(context);
  assert.equal(projection.currentState, 'completed');
  assert.equal(projection.activeState, 'normal');
  assert.equal(projection.outcome, 'completed');
  assert.equal(projection.allowedEvents.includes('context_answered'), true);
  assert.equal(projection.allowedEvents.includes('function_selected'), true);
});
