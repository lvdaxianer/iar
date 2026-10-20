import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeClientError, IarBridgeClient, createIarExtension, PI_BRIDGE_VERSION, type BridgeInputResponse, type PiExtensionAPI, type PiExtensionContext } from '@iar/pi-bridge';

test('IAR bridge client sends bounded input and validates the response', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test/',
    fetch: async (input, options) => {
      calls.push({ url: String(input), body: String(options?.body ?? '') });
      return Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'pass_through' });
    }
  });
  const result = await client.input('iar-1', '普通问题');
  assert.equal(result.disposition, 'pass_through');
  assert.equal(calls[0]?.url, 'http://iar.test/api/bridge/v1/sessions/iar-1/input');
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { text: '普通问题' });
});

test('Pi extension continues pass-through and handles IAR results', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const commands = new Map<string, { handler: (args: string, context: PiExtensionContext) => Promise<void> }>();
  const messages: unknown[] = [];
  const notifications: string[] = [];
  let inputCalls = 0;
  const responses: BridgeInputResponse[] = [
    { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'pass_through' },
    { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'awaiting_confirmation', reply: '请确认', pending: { actionId: 'action-1', runId: 'run-1', functionId: 'f', pluginId: 'p', riskLevel: 'high', confirmationRequired: true } }
  ];
  const fakeClient = {
    openSession: async () => ({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-1', iarSessionId: 'iar-1', resumed: false }),
    input: async () => { inputCalls += 1; return responses.shift() ?? { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled', reply: '已处理' }; },
    confirm: async (_sessionId: string, actionId: string, accepted: boolean) => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled' as const, reply: `${actionId}:${String(accepted)}` }),
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1' })
  };
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: (name, definition) => { commands.set(name, definition); },
    sendMessage: (message) => { messages.push(message); }
  };
  await createIarExtension({ client: fakeClient })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(await handlers.get('input')?.({ text: '普通问题', source: 'interactive' }, context), { action: 'continue' });
  assert.deepEqual(await handlers.get('input')?.({ text: '执行动作', source: 'interactive' }, context), { action: 'handled' });
  assert.equal(messages.length, 1);
  assert.deepEqual(await handlers.get('input')?.({ text: '由扩展注入', source: 'extension' }, context), { action: 'continue' });
  assert.equal(inputCalls, 2);
  await commands.get('iar-confirm')?.handler('', context);
  assert.equal(messages.length, 2);
  assert.deepEqual(notifications, []);
});

test('Pi extension fails closed when IAR is unavailable', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const notifications: string[] = [];
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: () => {},
    sendMessage: () => {}
  };
  const client = { openSession: async () => { throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true); }, input: async () => { throw new Error('unreachable'); }, confirm: async () => { throw new Error('unreachable'); }, state: async () => { throw new Error('unreachable'); } };
  await createIarExtension({ client })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(notifications, ['IAR 桥接不可用，当前输入已安全阻断。']);
  assert.deepEqual(await handlers.get('input')?.({ text: '业务请求', source: 'interactive' }, context), { action: 'handled' });
});
