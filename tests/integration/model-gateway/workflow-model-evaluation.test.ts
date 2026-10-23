import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContract, type BehaviorContext } from '@iar/contracts';
import { WORKFLOW_EVALUATION_SCENARIOS, type WorkflowEvaluationScenario } from './workflow-evaluation-fixtures.js';

function assertScenarioShape(scenario: WorkflowEvaluationScenario): void {
  assert.match(scenario.id, /^[a-z0-9-]+$/);
  assert.ok(scenario.userText.length > 0);
  assert.ok(['normal', 'function_selection', 'parameter_collection', 'awaiting_confirmation', 'pass_through'].includes(scenario.currentStage));
  assert.ok(['clarification', 'awaiting_confirmation', 'executed', 'cancelled', 'pass_through', 'context_answered', 'unavailable'].includes(scenario.expected.nextStage));
  assert.equal(validateContract('behaviorContext', scenario.behaviorContext).ok, true, scenario.id);
  assert.ok(Array.isArray(scenario.pluginDescriptors));
  assert.ok(scenario.pluginDescriptors.every((descriptor) => descriptor.pluginId));
  assert.equal(scenario.secrets, undefined);
}

test('workflow evaluation corpus covers realistic state transitions with valid structured context', () => {
  assert.ok(WORKFLOW_EVALUATION_SCENARIOS.length >= 10);
  const ids = new Set<string>();
  for (const scenario of WORKFLOW_EVALUATION_SCENARIOS) {
    assert.equal(ids.has(scenario.id), false, `duplicate scenario: ${scenario.id}`);
    ids.add(scenario.id);
    assertScenarioShape(scenario);
  }
  assert.ok(WORKFLOW_EVALUATION_SCENARIOS.some((scenario) => scenario.currentStage === 'parameter_collection'));
  assert.ok(WORKFLOW_EVALUATION_SCENARIOS.some((scenario) => scenario.currentStage === 'awaiting_confirmation'));
  assert.ok(WORKFLOW_EVALUATION_SCENARIOS.some((scenario) => scenario.expected.nextStage === 'cancelled'));
  assert.ok(WORKFLOW_EVALUATION_SCENARIOS.some((scenario) => scenario.expected.nextStage === 'pass_through'));
});

test('workflow evaluation fixtures preserve named route and parameter state', () => {
  const parameterCase = WORKFLOW_EVALUATION_SCENARIOS.find((scenario) => scenario.id === 'parameter-merge-current-value-wins');
  assert.ok(parameterCase);
  const context = parameterCase.behaviorContext as BehaviorContext;
  assert.equal(context.route.functionId, 'function.synthetic.rate');
  assert.equal(context.route.pluginId, 'plugin.synthetic.control');
  assert.equal(context.collection?.kind, 'parameters');
  if (context.collection?.kind !== 'parameters') return;
  assert.deepEqual(context.collection.collected, { operation: 'update', rate: 100 });
  assert.deepEqual(context.collection.missingFields, ['burst']);
  assert.deepEqual(context.collection.invalidFields, []);
  assert.deepEqual(context.collection.conflictFields, []);
});

test('workflow evaluation corpus keeps disabled targets out of the authorized descriptor set', () => {
  const unavailable = WORKFLOW_EVALUATION_SCENARIOS.find((scenario) => scenario.id === 'disabled-plugin-cannot-recover');
  assert.ok(unavailable);
  assert.equal(unavailable.behaviorContext.route.pluginId, 'plugin.synthetic.disabled');
  assert.equal(unavailable.pluginDescriptors.some((descriptor) => descriptor.pluginId === 'plugin.synthetic.disabled'), false);
  assert.equal(unavailable.expected.execute, false);
});
