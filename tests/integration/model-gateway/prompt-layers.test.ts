/** 验证模型提示词分层组合顺序和固定角色协议边界。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { composePromptLayers } from '../../../examples/agent-sandbox/src/models/model-input-transport.js';

test('提示词按 Runtime、Agent、Plugin、角色协议顺序组合', () => {
  const prompt = composePromptLayers({
    basePrompt: 'RUNTIME_RULES',
    agentPrompt: 'AGENT_STYLE',
    supplementaryPrompt: 'PLUGIN_STYLE',
    roleContract: 'ROLE_CONTRACT'
  });

  assert.deepEqual(prompt.split('\n'), ['RUNTIME_RULES', '<agent_prompt>', 'AGENT_STYLE', '</agent_prompt>', '<plugin_prompt>', 'PLUGIN_STYLE', '</plugin_prompt>', 'ROLE_CONTRACT']);
});

test('缺少用户提示词时仍保留固定角色协议', () => {
  assert.equal(composePromptLayers({ basePrompt: 'RUNTIME_RULES', roleContract: 'ROLE_CONTRACT' }), 'RUNTIME_RULES\nROLE_CONTRACT');
});
