/** 验证 @iar/runtime 的独立入口和 Pi 宿主适配边界。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PI_BRIDGE_VERSION } from '@iar/pi-bridge';
import { createIarRuntime, type AsyncDecisionAdapter } from '@iar/runtime';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

const decisionProvider: AsyncDecisionAdapter = {
  decide: async () => ({
    ok: false,
    error: {
      code: 'model.no_profile',
      message: '决策模型 backend 未配置',
      retryable: false,
      details: {},
    },
    audit: [],
    events: [],
  }),
};

test('standalone runtime initializes from a valid Plugin package', () => {
  const runtime = createIarRuntime({
    plugins: [pluginPackage(loadBusinessManifest(), 'ticket.query')],
    decisionProvider,
  });

  assert.equal(runtime.decisionProvider, decisionProvider);
  assert.deepEqual(runtime.functionRegistry.list().map((definition) => definition.functionId), ['ticket.query']);
});

test('standalone runtime rejects an invalid Plugin before exposing partial state', () => {
  assert.throws(
    () => createIarRuntime({ plugins: [], decisionProvider }),
    /plugin|Function|empty|插件/i
  );
});

test('Pi remains an explicit host adapter boundary', () => {
  assert.equal(PI_BRIDGE_VERSION, 'iar.pi-bridge/v1');
  assert.equal(typeof createIarRuntime, 'function');
});
