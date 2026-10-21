import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeClientError, PI_BRIDGE_VERSION, type BridgeConfirmResponse, type BridgeInputResponse, type BridgeRouteEvidence, type IarBridgeClientLike } from '@iar/pi-bridge';
import { buildPiHostApp } from '../../../examples/agent-sandbox/src/pi-host/pi-host-server.js';
import { PiHostSession, type PiHostRouteInfo, type PiHostSessionEvents } from '../../../examples/agent-sandbox/src/pi-host/pi-host-session.js';
import type { PiAgentDelegate } from '../../../examples/agent-sandbox/src/models/pi-agent-delegate.js';

/** 判定假桥的业务命中规则；与沙箱话术无关，只按本测试的输入约定分流。 */
function isBusiness(text: string): boolean {
  return /工单|限流|告警/.test(text);
}

function businessRoute(): BridgeRouteEvidence {
  return { status: 'matched', reasonCode: 'none', semanticIntent: 'api.gateway', semanticConfidence: 0.92, functionId: 'api.gateway', pluginId: 'api-gateway-v1' };
}

function makeFakeBridge(overrides: { input?: (text: string) => BridgeInputResponse; onConfirm?: (actionId: string, accepted: boolean) => void; failOpen?: boolean } = {}): IarBridgeClientLike {
  return {
    openSession: async () => {
      if (overrides.failOpen) throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true);
      return { version: PI_BRIDGE_VERSION, piSessionId: 'pi-demo', iarSessionId: 'iar-demo', resumed: false };
    },
    input: async (_sessionId, text) => {
      if (overrides.failOpen) throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true);
      if (overrides.input) return overrides.input(text);
      if (isBusiness(text)) return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'handled', reply: '已受理：' + text, replySource: 'response_model', route: businessRoute() };
      return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'pass_through', route: { status: 'noul', reasonCode: 'no_candidate', semanticIntent: 'unknown', semanticConfidence: 0.2 } };
    },
    confirm: async (_sessionId, actionId, accepted): Promise<BridgeConfirmResponse> => {
      overrides.onConfirm?.(actionId, accepted);
      return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'handled', reply: accepted ? '已确认执行。' : '已取消该操作。' };
    },
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo' })
  };
}

/** 记录事件的会话探针；piAgent 为 undefined 时使用真实 scripted 委托。 */
function makeProbe(options: { client: IarBridgeClientLike; piAgent?: PiAgentDelegate; awaitingActionId?: string }) {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const routes: PiHostRouteInfo[] = [];
  const confirms: Array<unknown> = [];
  const timings: Array<unknown> = [];
  const deltas: string[] = [];
  const piDones: string[] = [];
  const recorded: Array<{ userText: string; reply: string }> = [];
  const piRuns: string[] = [];
  const events: PiHostSessionEvents = {
    onEntry: (entry) => { entries.push(entry); },
    onNotify: (message, type) => { notifications.push({ message, type }); },
    onRoute: (route) => { routes.push(route); },
    onConfirm: (pending) => { confirms.push(pending); },
    onTiming: (timing) => { timings.push(timing); },
    onPiDelta: (delta) => { deltas.push(delta); },
    onPiDone: (reply) => { piDones.push(reply); }
  };
  const piAgent: PiAgentDelegate = options.piAgent ?? {
    run: async (text) => { piRuns.push(text); return /你是谁/.test(text) ? '我是 IAR Agent Sandbox 里的 Pi Agent。' : 'Pi 通用回答：' + text; },
    recordHandledTurn: (userText, reply) => { recorded.push({ userText, reply }); },
    reset: () => {}
  };
  const session = new PiHostSession({ sessionId: 'pi-demo', mode: 'scripted', client: options.client, piAgent, events });
  return { session, entries, notifications, routes, confirms, timings, deltas, piDones, recorded, piRuns };
}

test('Pi host session routes business input to IAR and blocks the Pi Agent', async () => {
  const probe = makeProbe({ client: makeFakeBridge() });
  await probe.session.start();
  const result = await probe.session.handleUserInput('把订单接口的限流阈值调到每秒 50 次');
  assert.deepEqual(result, { action: 'handled' });
  assert.deepEqual(probe.piRuns, []);
  assert.equal(probe.entries.length, 1);
  assert.deepEqual(probe.entries[0], { customType: 'iar-bridge', data: { content: '已受理：把订单接口的限流阈值调到每秒 50 次', disposition: 'handled', replySource: 'response_model' } });
  assert.equal(probe.routes.length, 1);
  assert.equal(probe.routes[0]?.functionId, 'api.gateway');
  assert.equal(probe.routes[0]?.disposition, 'handled');
  assert.equal(probe.routes[0]?.replySource, 'response_model');
  // handled 轮次以备注进入 Pi 侧 transcript，后续追问才有上下文。
  assert.deepEqual(probe.recorded, [{ userText: '把订单接口的限流阈值调到每秒 50 次', reply: '已受理：把订单接口的限流阈值调到每秒 50 次' }]);
});

test('Pi host session forwards bridge timing to the UI event boundary', async () => {
  const timing = { traceId: 'trace-1', durationMs: 120, stages: [{ stage: 'semantic.extract' as const, status: 'completed' as const, durationMs: 40 }] };
  const probe = makeProbe({ client: makeFakeBridge({ input: () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'handled', reply: '已查询', timing }) }) });
  await probe.session.start();
  await probe.session.handleUserInput('查询状态');
  assert.deepEqual(probe.timings, [timing]);
});

test('Pi host session lets the Pi Agent answer non-business input', async () => {
  const probe = makeProbe({ client: makeFakeBridge() });
  await probe.session.start();
  const result = await probe.session.handleUserInput('你是谁');
  assert.deepEqual(result, { action: 'continue' });
  assert.deepEqual(probe.piRuns, ['你是谁']);
  assert.deepEqual(probe.piDones, ['我是 IAR Agent Sandbox 里的 Pi Agent。']);
  assert.equal(probe.entries.length, 0);
  assert.equal(probe.routes[0]?.disposition, 'pass_through');
  // 未命中轮次不写入 handled 备注，Pi 自己的回复已在 Pi 上下文里。
  assert.deepEqual(probe.recorded, []);
});

test('Pi host session forwards pass-through capability context to the Pi Agent', async () => {
  let seenDescriptors: unknown;
  const piAgent: PiAgentDelegate = {
    run: async (text: string, _onDelta: (delta: string) => void, descriptors?: unknown) => {
      seenDescriptors = descriptors;
      return `Pi 回答：${text}`;
    },
    recordHandledTurn: () => undefined,
    reset: () => undefined
  };
  const client = makeFakeBridge({
    input: () => ({
      version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'pass_through',
      route: { status: 'noul', reasonCode: 'no_candidate', semanticIntent: 'unknown', semanticConfidence: 0.2 },
      capabilityContext: { functionDescriptors: [{ functionId: 'function.visible', pluginId: 'plugin.visible', description: '当前可用能力', actionTypes: ['query'] }] }
    } as unknown as BridgeInputResponse)
  });
  const probe = makeProbe({ client, piAgent });
  await probe.session.start();
  await probe.session.handleUserInput('你好');
  assert.deepEqual(seenDescriptors, [{ functionId: 'function.visible', pluginId: 'plugin.visible', description: '当前可用能力', actionTypes: ['query'] }]);
});

test('Pi host session forwards iar-cancel and clears the pending banner', async () => {
  const confirmations: Array<{ actionId: string; accepted: boolean }> = [];
  const client = makeFakeBridge({
    input: (text) => isBusiness(text)
      ? { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'awaiting_confirmation', reply: '请确认', route: businessRoute(), pending: { actionId: 'action-7', runId: 'run-7', functionId: 'api.gateway', pluginId: 'api-gateway-v1', riskLevel: 'high', confirmationRequired: true } }
      : { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-demo', disposition: 'pass_through', route: { status: 'noul', reasonCode: 'no_candidate', semanticIntent: 'unknown', semanticConfidence: 0.2 } },
    onConfirm: (actionId, accepted) => { confirmations.push({ actionId, accepted }); }
  });
  const probe = makeProbe({ client });
  await probe.session.start();
  await probe.session.handleUserInput('删除告警规则');
  assert.equal(probe.entries.length, 1);
  assert.deepEqual(probe.confirms.at(-1), { actionId: 'action-7', runId: 'run-7', functionId: 'api.gateway', pluginId: 'api-gateway-v1', riskLevel: 'high', confirmationRequired: true });
  const forwarded = await probe.session.confirm(false);
  assert.equal(forwarded, true);
  assert.deepEqual(confirmations, [{ actionId: 'action-7', accepted: false }]);
  assert.deepEqual(probe.entries.at(-1), { customType: 'iar-bridge', data: { content: '已取消该操作。', disposition: 'cancelled' } });
  assert.deepEqual(probe.confirms.at(-1), null);
});

test('Pi host session fails closed when the bridge is unavailable', async () => {
  const probe = makeProbe({ client: makeFakeBridge({ failOpen: true }) });
  await probe.session.start();
  // 启动期已告知一次桥接不可用；fail-closed 下输入被安全阻断且不追加新通知。
  const notifiedAtStart = probe.notifications.length;
  assert.ok(notifiedAtStart >= 1);
  const result = await probe.session.handleUserInput('随便问一句');
  assert.deepEqual(result, { action: 'handled' });
  assert.deepEqual(probe.piRuns, []);
  assert.deepEqual(probe.notifications.length, notifiedAtStart);
  assert.equal(probe.notifications[0]?.message, 'IAR 桥接不可用，当前输入已安全阻断。');
});

test('Pi host app serves the page and processes chat over HTTP', async t => {
  const probeBridge = makeFakeBridge();
  const { app, closeClients } = buildPiHostApp({ mode: 'scripted', client: probeBridge, pageHtml: '<html><body><div id="transcript"></div></body></html>' });
  t.after(async () => { closeClients(); await app.close(); });
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /transcript/);
  const chat = await app.inject({ method: 'POST', url: '/api/pi-host/chat', payload: { session: 'http-demo', text: '查一下今天的告警' } });
  assert.equal(chat.statusCode, 200);
  assert.deepEqual(chat.json(), { action: 'handled' });
  const bad = await app.inject({ method: 'POST', url: '/api/pi-host/chat', payload: { session: 'http-demo', text: '  ' } });
  assert.equal(bad.statusCode, 400);
  const badSession = await app.inject({ method: 'POST', url: '/api/pi-host/confirm', payload: { session: '非法 id!', accepted: true } });
  assert.equal(badSession.statusCode, 400);
});

test('Pi host app serves assembled shared page by default', async t => {
  const { app, closeClients } = buildPiHostApp({ mode: 'scripted', client: makeFakeBridge() });
  t.after(async () => { closeClients(); await app.close(); });
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="messages"/);
  assert.match(page.body, /function renderMarkdown\(src\)/);
  assert.match(page.body, /function renderPiHostEntry\(entry\)/);
  assert.doesNotMatch(page.body, /IAR_PI_HOST_(?:STYLES|SCRIPT)/);
});
