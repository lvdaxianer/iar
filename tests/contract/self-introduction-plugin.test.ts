/** 验证内置自我介绍 Plugin、Agent 配置和结构化能力聚合边界。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SELF_INTRODUCTION_FUNCTION_ID,
  SELF_INTRODUCTION_PLUGIN_ID,
  selfIntroductionPlugin
} from '@iar/plugins';
import { createIarAgent, type AsyncDecisionAdapter } from '@iar/runtime';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

const decisionProvider: AsyncDecisionAdapter = {
  decide: async () => ({
    ok: false,
    error: { code: 'model.no_profile', message: '决策模型 backend 未配置', retryable: false, details: {} },
    audit: [],
    events: []
  })
};

test('内置自我介绍 Plugin 聚合插件描述并保留额外提示词', async () => {
  const registration = selfIntroductionPlugin.functions[0];
  assert.ok(registration);
  const result = await registration.handler({
    plugins: [{ pluginId: 'ticket-plugin', functionId: 'ticket.query', description: '查询工单' }],
    extraPrompt: '语气更简洁'
  }, { pluginId: SELF_INTRODUCTION_PLUGIN_ID, functionId: SELF_INTRODUCTION_FUNCTION_ID, runId: 'run-1', correlationId: 'run-1' });

  assert.deepEqual(result, {
    status: 'succeeded',
    output: {
      plugins: [{ pluginId: 'ticket-plugin', functionId: 'ticket.query', description: '查询工单' }],
      extraPrompt: '语气更简洁'
    }
  });
});

test('自我介绍 Plugin 对不受信任的能力输入 fail-closed', async () => {
  const registration = selfIntroductionPlugin.functions[0];
  assert.ok(registration);
  const result = await registration.handler({ plugins: [{ pluginId: 'plugin', functionId: 'function', description: '' }] }, { pluginId: SELF_INTRODUCTION_PLUGIN_ID, functionId: SELF_INTRODUCTION_FUNCTION_ID, runId: 'run-2', correlationId: 'run-2' });
  assert.deepEqual(result, { status: 'failed', output: { errorCode: 'self_introduction.invalid_input' }, errorCode: 'self_introduction.invalid_input' });
});

test('新建 Agent 默认安装自我介绍 Plugin，并持久化关闭项与提示词配置', () => {
  const ticketPlugin = pluginPackage(loadBusinessManifest(), 'ticket.query');
  const agent = createIarAgent({
    plugins: [ticketPlugin],
    decisionProvider,
    disabledPluginIds: [ticketPlugin.manifest.pluginId],
    selfIntroduction: { extraPrompt: '先说结论' }
  });

  assert.deepEqual(agent.configuration, {
    disabledPluginIds: [ticketPlugin.manifest.pluginId],
    selfIntroduction: { extraPrompt: '先说结论' }
  });
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), [SELF_INTRODUCTION_FUNCTION_ID]);
});

test('自我介绍 Plugin 不能被关闭，未知关闭项被拒绝', () => {
  const ticketPlugin = pluginPackage(loadBusinessManifest(), 'ticket.query');
  assert.throws(() => createIarAgent({ plugins: [ticketPlugin], decisionProvider, disabledPluginIds: [SELF_INTRODUCTION_PLUGIN_ID] }), /自我介绍|关闭|disable/i);
  assert.throws(() => createIarAgent({ plugins: [ticketPlugin], decisionProvider, disabledPluginIds: ['plugin.unknown'] }), /未知|不存在|plugin/i);
  assert.throws(() => createIarAgent({ plugins: [ticketPlugin], decisionProvider, selfIntroduction: { extraPrompt: 'x'.repeat(1001) } }), /提示词|长度/i);
});

test('Runtime 不允许调用方覆盖内置自我介绍实现', () => {
  const ticketPlugin = pluginPackage(loadBusinessManifest(), 'ticket.query');
  const suppliedBuiltin = pluginPackage({ ...loadBusinessManifest(), pluginId: SELF_INTRODUCTION_PLUGIN_ID }, SELF_INTRODUCTION_FUNCTION_ID);
  const agent = createIarAgent({ plugins: [ticketPlugin, suppliedBuiltin], decisionProvider });

  const definitions = agent.functionRegistry.list();
  assert.deepEqual(definitions.map((definition) => definition.functionId), ['ticket.query', SELF_INTRODUCTION_FUNCTION_ID]);
  assert.equal(definitions[1]?.description, '介绍当前 Agent 已启用的 Plugin 能力');
});
