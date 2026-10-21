/** 验证沙箱通过真实自我介绍 Plugin 完成意图、执行和模型回复。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SELF_INTRODUCTION_FUNCTION_ID, SELF_INTRODUCTION_PLUGIN_ID } from '@iar/plugins';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('self-introduction intent executes the built-in Plugin and uses scoped configuration', async () => {
  const session = new IarSandboxSession({
    mode: 'scripted',
    disabledPluginIds: ['knowledge-query-v1'],
    selfIntroduction: { extraPrompt: '先说结论，再列能力' }
  });

  const result = await session.turn('hi');

  assert.equal(result.status, 'executed');
  if (result.status !== 'executed') return;
  assert.equal(result.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);
  assert.match(result.reply, /先说结论，再列能力/);
  assert.match(result.reply, /数据集成管理/);
  assert.doesNotMatch(result.reply, /平台使用 FAQ/);
  session.dispose();
});

test('self-introduction Plugin is enabled by default but can be disabled at Agent creation', async () => {
  const enabled = new IarSandboxSession({ mode: 'scripted' });
  try {
    const enabledResult = await enabled.turn('介绍下自己呢');
    assert.equal(enabledResult.status, 'executed');
    if (enabledResult.status === 'executed') assert.equal(enabledResult.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);

    const disabled = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: [SELF_INTRODUCTION_PLUGIN_ID] });
    try {
      const disabledResult = await disabled.turn('介绍下自己呢');
      assert.notEqual(disabledResult.status, 'executed');
      assert.notEqual(disabledResult.route?.functionId, SELF_INTRODUCTION_FUNCTION_ID);
      const descriptors = (disabled as unknown as { pluginHost: { descriptors: () => Array<{ functionId: string }> } }).pluginHost.descriptors();
      assert.equal(descriptors.some((descriptor) => descriptor.functionId === SELF_INTRODUCTION_FUNCTION_ID), false);
    } finally {
      disabled.dispose();
    }
  } finally {
    enabled.dispose();
  }
});
