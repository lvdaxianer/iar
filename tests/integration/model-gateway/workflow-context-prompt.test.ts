/*
 * 验证真实 semantic.extract 提示词同时接收 BehaviorContext 和有界 Workflow context。
 * 测试只使用动态 Function/Plugin 标识，不把业务能力写入系统提示词。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialContext, projectWorkflowContext } from '@iar/runtime';
import { buildSemanticUserPrompt, SEMANTIC_SYSTEM_PROMPT } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';

test('semantic prompt exposes the current workflow map and bounded state', () => {
  const behaviorContext = createInitialContext('run-workflow-prompt');
  behaviorContext.workflow = { currentStep: 'collecting_parameters', status: 'waiting' };
  behaviorContext.route = { functionId: 'function.dynamic', pluginId: 'plugin.dynamic' };
  behaviorContext.pending = { kind: 'slot', status: 'required' };
  behaviorContext.collection = {
    kind: 'parameters',
    functionId: 'function.dynamic',
    pluginId: 'plugin.dynamic',
    schemaVersion: 'schema-v1',
    collected: { existing: 'value' },
    missingFields: ['nextField'],
    invalidFields: [],
    conflictFields: [],
    attempt: 1,
    presentation: { nextField: { label: 'Next field', control: 'text' } }
  };

  const prompt = buildSemanticUserPrompt({
    text: '补充字段',
    behaviorContext,
    workflowContext: projectWorkflowContext(behaviorContext),
    pluginDescriptors: [{ pluginId: 'plugin.dynamic', description: '授权能力', actionTypes: ['update'] }]
  });

  assert.match(prompt, /<workflow_context>/);
  assert.match(prompt, /iar\.workflow-map\/v1/);
  assert.match(prompt, /"currentState": "collecting_parameters"/);
  assert.match(prompt, /"parameter_received"/);
  assert.match(prompt, /"missingFields": \[\s*"nextField"/);
  const workflowSection = prompt.split('<workflow_context>')[1]?.split('</workflow_context>')[0] ?? '';
  assert.doesNotMatch(workflowSection, /"existing": "value"/);
});

test('semantic system prompt defines workflow event output as non-authoritative', () => {
  assert.match(SEMANTIC_SYSTEM_PROMPT, /workflowDecision/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /parameter_received/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /不能.*授权|不.*执行权限/u);
});
