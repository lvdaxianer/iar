/** 验证 Runtime 入口及迁移期 Agent 别名负责完整 Plugin 包装配。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SELF_INTRODUCTION_FUNCTION_ID } from '@iar/plugins';
import { createIarAgent, createIarRuntime } from '@iar/runtime';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

const decisionProvider = {
  decide: async () => ({
    ok: false as const,
    error: { code: 'model.no_profile' as const, message: '决策模型 backend 未配置', retryable: false, details: {} },
    audit: [],
    events: [],
  }),
};

test('unified Runtime entry and deprecated Agent alias are importable from one package root', () => {
  assert.equal(typeof createIarAgent, 'function');
  assert.equal(typeof createIarRuntime, 'function');
});

test('unified Agent rejects partial initialization when a Plugin is invalid', () => {
  assert.throws(() => createIarAgent({ plugins: [], decisionProvider }), /plugin|Function|empty|插件/i);
});

test('unified Agent FunctionRegistry follows Plugin lifecycle changes', () => {
  const plugin = pluginPackage(loadBusinessManifest(), 'ticket.query');
  const agent = createIarAgent({ plugins: [plugin], decisionProvider });
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), ['ticket.query', SELF_INTRODUCTION_FUNCTION_ID]);
  assert.equal(agent.pluginHost.disable(plugin.manifest.pluginId).ok, true);
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), [SELF_INTRODUCTION_FUNCTION_ID]);
  assert.equal(agent.pluginHost.enable(plugin.manifest.pluginId).ok, true);
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), ['ticket.query', SELF_INTRODUCTION_FUNCTION_ID]);
});
