import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('sandbox keeps JEV priority when both decision backends are configured', async () => {
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

test('sandbox can run with Intent Model only while preserving the public route result', async () => {
  const session = new IarSandboxSession({ mode: 'scripted', decisionBackend: 'intent-model' });
  try {
    const result = await session.turn('查一下退款政策');
    assert.equal(result.status, 'executed');
    assert.equal(result.route.functionId, 'knowledge.query');
    assert.equal(result.route.pluginId, 'knowledge-query-v1');
    assert.equal(result.route.operationKind, 'read');
    assert.equal(typeof result.route.functionScore, 'number');
    assert.equal(typeof result.route.pluginScore, 'number');
  } finally {
    session.dispose();
  }
});
