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
  assert.match(prompt, /"activeState": "collecting_parameters"/);
  assert.match(prompt, /"outcome": "none"/);
  assert.match(prompt, /"parameter_received"/);
  assert.match(prompt, /"missingFields": \[\s*"nextField"/);
  const workflowSection = prompt.split('<workflow_context>')[1]?.split('</workflow_context>')[0] ?? '';
  assert.doesNotMatch(workflowSection, /"existing": "value"/);
});

test('semantic system prompt defines workflow event output as non-authoritative', () => {
  assert.match(SEMANTIC_SYSTEM_PROMPT, /workflowDecision/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /parameter_received/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /context_answered/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /completed、cancelled、failed/);
  assert.match(SEMANTIC_SYSTEM_PROMPT, /不能.*授权|不.*执行权限/u);
});

test('semantic prompt gives a complete current request priority over stale route context', () => {
  const prompt = buildSemanticUserPrompt({
    text: '一个新的完整请求',
    behaviorContext: {
      route: { functionId: 'function.previous', pluginId: 'plugin.previous' },
      pending: { kind: 'none', status: 'none' },
      workflow: { currentStep: 'completed', status: 'completed' }
    },
    recentMessages: [{ role: 'user', text: '上一轮请求' }]
  });

  assert.match(prompt, /当前用户问题.*唯一的本轮语义来源/u);
  assert.match(prompt, /完整请求.*不得.*继承.*上一轮.*Function|当前问题.*明确.*新对象.*不得.*迁移/u);
  assert.ok(prompt.lastIndexOf('本轮语义来源') > prompt.indexOf('</plugin_descriptors>'));
  assert.ok(prompt.lastIndexOf('<current_user_question>') > prompt.indexOf('</plugin_descriptors>'));
  assert.match(prompt.slice(prompt.lastIndexOf('<current_user_question>')), /一个新的完整请求/);
});

test('semantic prompt requires exact closed-set Function identifiers', () => {
  const prompt = buildSemanticUserPrompt({ text: '调整新的参数', pluginDescriptors: [{ functionId: 'function.current', pluginId: 'plugin.current' }] });
  assert.match(SEMANTIC_SYSTEM_PROMPT, /逐字比对当前 plugin_descriptors\.functionId/u);
  assert.match(prompt, /不能输出新别名/u);
  assert.match(prompt, /只允许逐字复制 plugin_descriptors 中的 functionId/u);
});
