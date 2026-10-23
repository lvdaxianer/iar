import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContract, type BehaviorContext, type JsonValue } from '@iar/contracts';
import type { SemanticFrame } from '@iar/runtime';
import { buildSemanticUserPrompt, SEMANTIC_SYSTEM_PROMPT } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';
import { DISABLED_PLUGIN, WORKFLOW_EVALUATION_SCENARIOS, type WorkflowEvaluationScenario } from './workflow-evaluation-fixtures.js';
import { evaluateWorkflowFrame, type WorkflowEvaluationFunction } from './workflow-evaluation-oracle.js';
import { buildWorkflowEvaluationReport } from './workflow-evaluation-report.js';

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
  assert.equal(unavailable.behaviorContext.route.pluginId, DISABLED_PLUGIN);
  assert.equal(unavailable.pluginDescriptors.some((descriptor) => descriptor.pluginId === DISABLED_PLUGIN), false);
  assert.equal(unavailable.expected.execute, false);
});

test('workflow evaluation captures the production semantic prompt context for parameter collection', () => {
  const scenario = findScenario('parameter-merge-current-value-wins');
  const prompt = buildSemanticUserPrompt({
    text: scenario.userText,
    behaviorContext: scenario.behaviorContext,
    recentMessages: scenario.recentMessages,
    pluginDescriptors: scenario.pluginDescriptors,
    structuredInput: scenario.structuredInput
  });
  assert.match(SEMANTIC_SYSTEM_PROMPT, /iar\.semantic-frame\/v2/);
  assert.match(prompt, /改成每秒 200 次/);
  assert.match(prompt, /<behavior_context>[\s\S]*function\.synthetic\.rate/);
  assert.match(prompt, /<behavior_context>[\s\S]*parameters_required/);
  assert.match(prompt, /<recent_messages>[\s\S]*请补充突发次数/);
  assert.match(prompt, /<pending_action>[\s\S]*null/);
  assert.match(prompt, /<structured_input>[\s\S]*\"rate\"/);
  assert.match(prompt, /<plugin_descriptors>[\s\S]*plugin\.synthetic\.control/);
  assert.doesNotMatch(prompt, new RegExp(DISABLED_PLUGIN));
});

test('workflow evaluation captures confirmation and enforces bounded recent-message evidence', () => {
  const scenario = findScenario('awaiting-confirmation-user-declines');
  const context = scenario.behaviorContext;
  const policy = context.recentMessagePolicy;
  assert.ok(policy);
  assert.ok(scenario.recentMessages.length <= policy.recentMessageLimit);
  assert.ok(scenario.recentMessages.every((message) => message.text.length <= policy.maxMessageChars));
  const prompt = buildSemanticUserPrompt({
    text: scenario.userText,
    behaviorContext: context,
    recentMessages: scenario.recentMessages,
    pendingAction: scenario.pendingAction,
    pluginDescriptors: scenario.pluginDescriptors
  });
  assert.match(prompt, /<behavior_context>[\s\S]*awaiting_confirmation/);
  assert.match(prompt, /<behavior_context>[\s\S]*\"state\": \"required\"/);
  assert.match(prompt, /<pending_action>[\s\S]*function\.synthetic\.rate/);
  assert.match(prompt, /<pending_action>[\s\S]*\"confirmationRequired\": true/);
  assert.match(prompt, /<recent_messages>[\s\S]*是否确认修改/);
});

test('workflow oracle restores a stable route before evaluating incomplete parameters', () => {
  const scenario = findScenario('stable-route-unknown-frame');
  const outcome = evaluateWorkflowFrame({
    frame: semanticFrame({ intent: 'unknown', action: 'update', slots: { rate: 200 } }),
    behaviorContext: scenario.behaviorContext,
    authorizedFunctions: [rateFunction()]
  });
  assert.equal(outcome.nextStage, 'clarification');
  assert.equal(outcome.execute, false);
  assert.equal(outcome.functionId, 'function.synthetic.rate');
  assert.equal(outcome.pluginId, 'plugin.synthetic.control');
  assert.equal(outcome.reasonCode, 'parameters_required');
  assert.equal(outcome.gates.descriptorMatched, true);
  assert.equal(outcome.gates.parameterCollectionCompleted, false);
});

test('workflow oracle rejects fabricated targets and keeps high-risk actions behind confirmation', () => {
  const fabricated = evaluateWorkflowFrame({
    frame: semanticFrame({ intent: 'function.fabricated', pluginId: 'plugin.fabricated', action: 'update' }),
    behaviorContext: findScenario('initial-function-missing').behaviorContext,
    authorizedFunctions: [rateFunction()]
  });
  assert.equal(fabricated.nextStage, 'unavailable');
  assert.equal(fabricated.execute, false);
  assert.equal(fabricated.functionId, undefined);
  assert.equal(fabricated.pluginId, undefined);
  assert.equal(fabricated.gates.descriptorMatched, false);

  const confirmationScenario = findScenario('confirmation-state-keeps-route');
  const confirmation = evaluateWorkflowFrame({
    frame: semanticFrame({ intent: 'function.synthetic.rate', pluginId: 'plugin.synthetic.control', action: 'update', slots: { operation: 'update', rate: 200, burst: 20 } }),
    behaviorContext: confirmationScenario.behaviorContext,
    authorizedFunctions: [rateFunction()]
  });
  assert.equal(confirmation.nextStage, 'awaiting_confirmation');
  assert.equal(confirmation.execute, false);
  assert.equal(confirmation.gates.policyValidated, true);
  assert.equal(confirmation.gates.confirmationSatisfied, false);
});

test('workflow oracle marks only fully gated low-risk input as executable', () => {
  const outcome = evaluateWorkflowFrame({
    frame: semanticFrame({ intent: 'function.synthetic.query', pluginId: 'plugin.synthetic.query', action: 'query', slots: { operation: 'query' } }),
    behaviorContext: findScenario('initial-function-missing').behaviorContext,
    authorizedFunctions: [queryFunction()]
  });
  assert.equal(outcome.nextStage, 'executed');
  assert.equal(outcome.execute, true);
  assert.equal(outcome.gates.schemaValidated, true);
  assert.equal(outcome.gates.parameterCollectionCompleted, true);
  assert.equal(outcome.gates.policyValidated, true);
  assert.equal(outcome.gates.idempotencyValidated, true);
  assert.equal(outcome.gates.confirmationSatisfied, true);
  assert.equal(outcome.gates.handlerReachable, true);
});

test('workflow evaluation report is bounded to stable transition evidence', () => {
  const scenario = findScenario('stable-route-unknown-frame');
  const outcome = evaluateWorkflowFrame({
    frame: semanticFrame({ intent: 'unknown', action: 'update', slots: { rate: 200 } }),
    behaviorContext: scenario.behaviorContext,
    authorizedFunctions: [rateFunction()]
  });
  const report = buildWorkflowEvaluationReport([{
    scenarioId: scenario.id,
    expected: scenario.expected,
    actual: outcome
  }]);
  const serialized = JSON.stringify(report);
  assert.deepEqual(report.summary, { total: 1, passed: 1, failed: 0 });
  assert.equal(report.scenarios[0]?.scenarioId, 'stable-route-unknown-frame');
  assert.equal(report.scenarios[0]?.actual.nextStage, 'clarification');
  assert.doesNotMatch(serialized, /改成每秒 200 次|\"rate\": 200|prompt|response|collected|api[_-]?key|secret/i);
});

function semanticFrame(input: { intent: string; action: SemanticFrame['action']; pluginId?: string; slots?: Record<string, JsonValue> }): SemanticFrame {
  return {
    schemaVersion: 'iar.semantic-frame/v2', intent: input.intent, action: input.action,
    slots: input.slots ?? {}, references: [], confidence: 0.95,
    ...(input.pluginId === undefined ? {} : { pluginId: input.pluginId })
  };
}

function rateFunction(): WorkflowEvaluationFunction {
  return {
    functionId: 'function.synthetic.rate', pluginId: 'plugin.synthetic.control', actionTypes: ['update'],
    inputSchema: { type: 'object', properties: { operation: { type: 'string' }, rate: { type: 'number' }, burst: { type: 'number' } }, required: ['operation', 'rate', 'burst'], additionalProperties: false },
    requiresConfirmation: true
  };
}

function queryFunction(): WorkflowEvaluationFunction {
  return {
    functionId: 'function.synthetic.query', pluginId: 'plugin.synthetic.query', actionTypes: ['query'],
    inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false },
    requiresConfirmation: false
  };
}

function findScenario(id: string): WorkflowEvaluationScenario {
  const scenario = WORKFLOW_EVALUATION_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `missing workflow evaluation scenario: ${id}`);
  return scenario;
}
