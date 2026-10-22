import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxModels } from '../../../examples/agent-sandbox/src/session-dependencies.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('sandbox defaults to Intent Model when JEV is not configured', async () => {
  await withEnv({ IAR_JEV_ENDPOINT: 'https://jev.example.test/v1', IAR_JEV_API_KEY: undefined, IAR_JEV_MODEL_ID: undefined, IAR_SANDBOX_DECISION_BACKEND: undefined }, () => {
    const models = createSandboxModels({ mode: 'scripted' });
    const selected = models.registry.list().filter((profile) => profile.role === 'function.select' || profile.role === 'plugin.select');
    assert.ok(selected.length > 0);
    assert.ok(selected.every((profile) => profile.decisionBackend === 'intent-model'));
  });
});

test('sandbox rejects explicit JEV when its configuration is incomplete', async () => {
  await withEnv({ IAR_JEV_ENDPOINT: undefined, IAR_JEV_API_KEY: undefined, IAR_JEV_MODEL_ID: undefined, IAR_SANDBOX_DECISION_BACKEND: undefined }, () => {
    assert.throws(() => createSandboxModels({ mode: 'scripted', decisionBackend: 'jev' }), /IAR_JEV_ENDPOINT、IAR_JEV_API_KEY 和 IAR_JEV_MODEL_ID 必须同时配置/);
  });
});

test('sandbox keeps JEV priority when JEV is explicitly configured', async () => {
  await withEnv({ IAR_JEV_ENDPOINT: 'https://jev.example.test/v1', IAR_JEV_API_KEY: 'test-key', IAR_JEV_MODEL_ID: 'jev-test', IAR_SANDBOX_DECISION_BACKEND: undefined }, () => {
    const models = createSandboxModels({ mode: 'scripted' });
    const selected = models.registry.list().filter((profile) => profile.role === 'function.select' || profile.role === 'plugin.select');
    assert.ok(selected.length > 0);
    assert.ok(selected.every((profile) => profile.decisionBackend === 'jev'));
    assert.ok(selected.every((profile) => profile.provider === 'jev'));
  });
});

test('sandbox can run with default Intent Model backend while preserving the public route result', async () => {
  await withEnv({ IAR_JEV_ENDPOINT: undefined, IAR_JEV_API_KEY: undefined, IAR_JEV_MODEL_ID: undefined, IAR_SANDBOX_DECISION_BACKEND: undefined }, async () => {
    const session = new IarSandboxSession({ mode: 'scripted' });
    try {
      const result = await session.turn('查一下退款政策');
      assert.equal(result.status, 'executed');
      assert.equal(result.route.functionId, 'knowledge.query');
      assert.equal(result.route.pluginId, 'knowledge-query-v1');
      assert.equal(result.route.operationKind, 'read');
    } finally {
      session.dispose();
    }
  });
});

test('sandbox can run with Intent Model only while preserving the public route result', async () => {
  const session = new IarSandboxSession({ mode: 'scripted', decisionBackend: 'intent-model' });
  try {
    const result = await session.turn('查一下退款政策');
    assert.equal(result.status, 'executed');
    assert.equal(result.route.functionId, 'knowledge.query');
    assert.equal(result.route.pluginId, 'knowledge-query-v1');
    assert.equal(result.route.operationKind, 'read');
  } finally {
    session.dispose();
  }
});

async function withEnv(values: Record<string, string | undefined>, callback: () => void | Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
