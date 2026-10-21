import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { PI_BRIDGE_VERSION } from '@iar/pi-bridge';
import { SELF_INTRODUCTION_FUNCTION_ID } from '@iar/plugins';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';

test('IAR bridge maps Pi sessions and passes through non-business input', async () => {
  const server = await startBridgeServer();
  try {
    const opened = await server.app.inject({ method: 'POST', url: '/api/bridge/v1/sessions', payload: { piSessionId: 'pi-session-a' } });
    assert.equal(opened.statusCode, 201);
    const first = opened.json() as { version: string; iarSessionId: string; resumed: boolean };
    assert.equal(first.version, PI_BRIDGE_VERSION); assert.equal(first.resumed, false);
    const resumed = await server.app.inject({ method: 'POST', url: '/api/bridge/v1/sessions', payload: { piSessionId: 'pi-session-a' } });
    assert.equal(resumed.json().iarSessionId, first.iarSessionId); assert.equal(resumed.json().resumed, true);
    const passThrough = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first.iarSessionId}/input`, payload: { text: '帮我写一个 TypeScript 函数' } });
    assert.equal(passThrough.statusCode, 200); assert.equal(passThrough.json().disposition, 'pass_through'); assert.equal(passThrough.json().replySource, 'pi_agent');
    const capabilityContext = passThrough.json().capabilityContext as { functionDescriptors: Array<{ functionId: string; pluginId: string; description: string; actionTypes: string[] }> };
    assert.ok(Array.isArray(capabilityContext.functionDescriptors));
    assert.ok(capabilityContext.functionDescriptors.some((descriptor) => descriptor.functionId === SELF_INTRODUCTION_FUNCTION_ID));
    assert.equal(capabilityContext.functionDescriptors.some((descriptor) => descriptor.pluginId === 'knowledge-query-v1'), true);
    assert.ok(capabilityContext.functionDescriptors.every((descriptor) => !('input' in descriptor)));
    const ordinary = await server.app.inject({ method: 'POST', url: '/api/chat', payload: { message: '帮我写一个 TypeScript 函数' } });
    assert.equal(ordinary.statusCode, 200); assert.equal(ordinary.json().status, 'agent');
  } finally { await server.close(); }
});

test('IAR bridge handles business input and protects confirmation isolation', async () => {
  const server = await startBridgeServer();
  try {
    const first = await openBridgeSession(server, 'pi-session-a');
    const handled = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/input`, payload: { text: '查一下退款政策' } });
    assert.equal(handled.statusCode, 200); assert.equal(handled.json().disposition, 'handled'); assert.equal(handled.json().replySource, 'response_model');
    const pendingResponse = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/input`, payload: { text: '帮我创建工单' } });
    const pending = pendingResponse.json() as { disposition: string; pending: { actionId: string } };
    assert.equal(pending.disposition, 'awaiting_confirmation');
    const state = await server.app.inject({ method: 'GET', url: `/api/bridge/v1/sessions/${first}/state` });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().pending.actionId, pending.pending.actionId);
    const second = await openBridgeSession(server, 'pi-session-b');
    const secondPendingResponse = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${second}/input`, payload: { text: '帮我创建工单' } });
    const secondPending = secondPendingResponse.json() as { pending: { actionId: string } };
    assert.notEqual(secondPending.pending.actionId, pending.pending.actionId);
    const stale = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${second}/confirm`, payload: { actionId: pending.pending.actionId, accepted: false } });
    assert.equal(stale.statusCode, 409);
    const cancelled = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/confirm`, payload: { actionId: pending.pending.actionId, accepted: false } });
    assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().disposition, 'handled');
    const duplicate = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/confirm`, payload: { actionId: pending.pending.actionId, accepted: false } });
    assert.equal(duplicate.statusCode, 409);
  } finally { await server.close(); }
});

test('IAR bridge rejects malformed input before session mutation', async () => {
  const server = await startBridgeServer();
  try {
    const empty = await server.app.inject({ method: 'POST', url: '/api/bridge/v1/sessions', payload: { piSessionId: '' } });
    assert.equal(empty.statusCode, 400); assert.equal(empty.json().code, 'invalid_pi_session_id');
    const created = await openBridgeSession(server, 'pi-session-c');
    const invalid = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${created}/input`, payload: { text: '' } });
    assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().code, 'invalid_bridge_input');
    const oversized = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${created}/input`, payload: { text: 'x'.repeat(4097) } });
    assert.equal(oversized.statusCode, 413); assert.equal(oversized.json().code, 'bridge_input_too_large');
  } finally { await server.close(); }
});

/** 启动离线 IAR 服务，端口探针保证多个测试进程可并行运行。 */
async function startBridgeServer() {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return startSandboxServer({ mode: 'scripted', port: address.port });
}

/** 创建测试用的 Pi→IAR 映射并返回 IAR 会话 ID。 */
async function openBridgeSession(server: Awaited<ReturnType<typeof startBridgeServer>>, piSessionId: string): Promise<string> {
  const response = await server.app.inject({ method: 'POST', url: '/api/bridge/v1/sessions', payload: { piSessionId } });
  assert.equal(response.statusCode, 201);
  return response.json().iarSessionId as string;
}
