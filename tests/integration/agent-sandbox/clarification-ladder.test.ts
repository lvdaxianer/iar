import assert from 'node:assert/strict';
import test from 'node:test';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('命中 API 网关 Function 但未确定 Operation 时只展示 Operation 目录', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const result = await session.turn('网关这边帮我看看');
    assert.equal(result.status, 'clarification');
    assert.equal(result.reasonCode, 'operation_missing');
    assert.equal(result.route.functionId, 'api.gateway');
    assert.equal(result.route.pluginId, 'api-gateway-v1');
    assert.match(result.reply, /search|stats/u);
    assert.match(result.reply, /具体操作|选择/u);
    assert.equal((await session.state()).pending, null);
    assert.equal((await session.state()).context.collection?.kind, 'parameters');
  } finally {
    session.dispose();
  }
});

test('Operation 补充后继续使用同一 Function，并在缺少业务参数时继续澄清', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const first = await session.turn('网关这边帮我看看');
    assert.equal(first.status, 'clarification');
    assert.equal(first.reasonCode, 'operation_missing');
    const continued = await session.turn('stats');
    assert.equal(continued.status, 'executed');
    assert.equal(continued.route.functionId, 'api.gateway');
    assert.equal(continued.route.pluginId, 'api-gateway-v1');
    assert.equal('pending' in continued, false);
  } finally {
    session.dispose();
  }
});

test('非法 Operation 补充不会跨 Function 路由或执行', async () => {
  const session = new IarSandboxSession({ mode: 'scripted' });
  try {
    const first = await session.turn('网关这边帮我看看');
    assert.equal(first.status, 'clarification');
    assert.equal(first.reasonCode, 'operation_missing');
    const invalid = await session.turn('export');
    assert.notEqual(invalid.status, 'executed');
    assert.notEqual(invalid.status, 'awaiting_confirmation');
    assert.equal((await session.state()).pending, null);
  } finally {
    session.dispose();
  }
});
