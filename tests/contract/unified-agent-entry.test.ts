/** 验证统一 Agent 入口负责完整 Plugin 包装配。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIarAgent } from '@iar/agent';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

test('unified Agent entry is importable from the package root', () => {
  assert.equal(typeof createIarAgent, 'function');
});

test('unified Agent rejects partial initialization when a Plugin is invalid', () => {
  assert.throws(() => createIarAgent({ plugins: [] }), /plugin|Function|empty|插件/i);
});

test('unified Agent FunctionRegistry follows Plugin lifecycle changes', () => {
  const plugin = pluginPackage(loadBusinessManifest(), 'ticket.query');
  const agent = createIarAgent({ plugins: [plugin] });
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), ['ticket.query']);
  assert.equal(agent.pluginHost.disable(plugin.manifest.pluginId).ok, true);
  assert.deepEqual(agent.functionRegistry.list(), []);
  assert.equal(agent.pluginHost.enable(plugin.manifest.pluginId).ok, true);
  assert.deepEqual(agent.functionRegistry.list().map((definition) => definition.functionId), ['ticket.query']);
});
