import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { PI_BRIDGE_VERSION } from '@iar/pi-bridge';
import { SELF_INTRODUCTION_FUNCTION_ID } from '@iar/plugins';
import type { CollectionState } from '@iar/contracts';
import type { PiAgentDelegate } from '../../../examples/agent-sandbox/src/models/pi-agent-delegate.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
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
    const intro = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/input`, payload: { text: '介绍一下自己' } });
    const introBody = intro.json() as { disposition: string; replySource: string; route: { functionId?: string; pluginId?: string; operationKind?: string } };
    assert.equal(introBody.disposition, 'handled');
    assert.equal(introBody.replySource, 'response_model');
    assert.equal(introBody.route.functionId, SELF_INTRODUCTION_FUNCTION_ID);
    assert.equal(introBody.route.pluginId, 'iar.self-introduction');
    assert.equal(introBody.route.operationKind, 'read');
    const handled = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/input`, payload: { text: '查一下退款政策' } });
    assert.equal(handled.statusCode, 200); assert.equal(handled.json().disposition, 'handled'); assert.equal(handled.json().replySource, 'response_model');
    assert.equal(handled.json().route.operationKind, 'read');
    const pendingResponse = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${first}/input`, payload: { text: '帮我创建工单' } });
    const pending = pendingResponse.json() as { disposition: string; pending: { actionId: string } };
    assert.equal(pending.disposition, 'awaiting_confirmation');
    const state = await server.app.inject({ method: 'GET', url: `/api/bridge/v1/sessions/${first}/state` });
    assert.equal(state.statusCode, 200);
    assert.equal(state.json().pending.actionId, pending.pending.actionId);
    const stateBody = state.json() as { structuredContext: { schemaVersion: string; conversationTurns: { turns: Array<Record<string, unknown>> }; slots: Record<string, Record<string, unknown>>; factHistory: { records: Array<Record<string, unknown>> } }; workflowState: { mapVersion: string; currentState: string } };
    assert.equal(stateBody.structuredContext.schemaVersion, 'iar.pi-structured-context/v1');
    assert.equal(stateBody.workflowState.mapVersion, 'iar.workflow-map/v1');
    assert.ok(Array.isArray(stateBody.structuredContext.conversationTurns.turns));
    assert.ok(Array.isArray(stateBody.structuredContext.factHistory.records));
    assert.equal(Object.values(stateBody.structuredContext.slots).some((slot) => 'value' in slot), false);
    assert.equal(JSON.stringify(stateBody).includes('scopeHash'), false);
    assert.equal(JSON.stringify(stateBody).includes('userText'), false);
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

test('IAR bridge restores a verified route for a generic continuation', async () => {
  const server = await startBridgeServer();
  try {
    const sessionId = await openBridgeSession(server, 'pi-session-continuation');
    const pendingResponse = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${sessionId}/input`, payload: { text: '把订单接口的限流值调整到每秒50次' } });
    const pending = pendingResponse.json() as { disposition: string; pending: { actionId: string } };
    assert.equal(pending.disposition, 'awaiting_confirmation');
    const confirmed = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${sessionId}/confirm`, payload: { actionId: pending.pending.actionId, accepted: true } });
    assert.equal(confirmed.statusCode, 200);
    const continuation = await server.app.inject({ method: 'POST', url: `/api/bridge/v1/sessions/${sessionId}/input`, payload: { text: '改成每秒200次吧' } });
    const body = continuation.json() as { disposition: string; replySource: string; route?: { functionId?: string; pluginId?: string }; pending?: { actionId?: string } };
    assert.equal(body.disposition, 'awaiting_confirmation');
    assert.equal(body.replySource, 'none');
    assert.equal(body.route?.functionId, 'api.gateway');
    assert.equal(body.route?.pluginId, 'api-gateway-v1');
    assert.ok(body.pending?.actionId);
  } finally { await server.close(); }
});

test('stale or disabled continuation targets cannot execute or reach Pi', async () => {
  for (const target of [
    { functionId: 'api.gateway', pluginId: 'api-gateway-v1', disabledPluginIds: ['api-gateway-v1'] },
    { functionId: 'missing.function', pluginId: 'missing-plugin', disabledPluginIds: [] }
  ]) {
    let piRuns = 0;
    const delegate: PiAgentDelegate = {
      run: async () => { piRuns += 1; return '不应调用'; },
      recordHandledTurn: () => undefined,
      reset: () => undefined
    };
    const session = new IarSandboxSession({ mode: 'scripted', disabledPluginIds: target.disabledPluginIds, piAgent: delegate });
    try {
      const collection: Extract<CollectionState, { kind: 'parameters' }> = {
        kind: 'parameters', functionId: target.functionId, pluginId: target.pluginId, schemaVersion: 'iar.function/v1',
        collected: { operation: 'limit' }, missingFields: ['params'], invalidFields: [], conflictFields: [], attempt: 1,
        presentation: { params: { label: '参数', control: 'object' } }
      };
      await session.updateParameterCollection(collection);
      const result = await session.turn('改成每秒200次吧');
      assert.equal(result.status, 'clarification');
      assert.equal(result.reasonCode, 'plugin_unavailable');
      assert.equal(result.route.functionId, target.functionId);
      assert.equal(result.route.pluginId, target.pluginId);
      assert.equal(piRuns, 0);
    } finally {
      session.dispose();
    }
  }
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
