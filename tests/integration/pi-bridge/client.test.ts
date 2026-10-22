import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeClientError, IarBridgeClient, createIarExtension, PI_BRIDGE_VERSION, type BridgeInputResponse, type PiExtensionAPI, type PiExtensionContext } from '@iar/pi-bridge';

test('IAR bridge client sends bounded input and validates the response', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test/',
    fetch: async (input, options) => {
      calls.push({ url: String(input), body: String(options?.body ?? '') });
      return Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'pass_through', replySource: 'pi_agent' });
    }
  });
  const result = await client.input('iar-1', '普通问题');
  assert.equal(result.disposition, 'pass_through');
  assert.equal(result.replySource, 'pi_agent');
  assert.equal(calls[0]?.url, 'http://iar.test/api/bridge/v1/sessions/iar-1/input');
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { text: '普通问题' });
});

test('IAR bridge client accepts optional pass-through capability context', async () => {
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({
      version: PI_BRIDGE_VERSION,
      iarSessionId: 'iar-1',
      disposition: 'pass_through',
      capabilityContext: { functionDescriptors: [{ functionId: 'f', pluginId: 'p', description: '可查询', actionTypes: ['query'] }] }
    })
  });
  const result = await client.input('iar-1', '普通问题');
  assert.deepEqual(result.capabilityContext, { functionDescriptors: [{ functionId: 'f', pluginId: 'p', description: '可查询', actionTypes: ['query'] }] });
});

test('IAR bridge client validates and preserves timing summary', async () => {
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({
      version: PI_BRIDGE_VERSION,
      iarSessionId: 'iar-1',
      disposition: 'handled',
      reply: '已查询',
      timing: { traceId: 'trace-1', durationMs: 120, stages: [{ stage: 'semantic.extract', status: 'completed', durationMs: 40 }] }
    })
  });
  const result = await client.input('iar-1', '查询状态');
  assert.deepEqual(result.timing, { traceId: 'trace-1', durationMs: 120, stages: [{ stage: 'semantic.extract', status: 'completed', durationMs: 40 }] });
});

test('IAR bridge client forwards final response reasoning before answer and validates done', async () => {
  const received: string[] = [];
  const events = [
    { type: 'reasoningDelta', text: '先核对结果。' },
    { type: 'delta', text: '查询结果如下。' },
    { type: 'done', result: { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled', reply: '查询结果如下。', replySource: 'response_model' } }
  ];
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => new Response(new ReadableStream({ start(controller) { const encoder = new TextEncoder(); events.forEach((event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } })
  });
  const result = await client.inputStream('iar-1', '查询状态', { onReasoningDelta: (text) => received.push(`reasoning:${text}`), onDelta: (text) => received.push(`answer:${text}`) });
  assert.deepEqual(received, ['reasoning:先核对结果。', 'answer:查询结果如下。']);
  assert.equal(result.reply, '查询结果如下。');
});

test('IAR bridge client rejects reasoning arriving after answer delta', async () => {
  const events = [
    { type: 'delta', text: '答案' },
    { type: 'reasoningDelta', text: '迟到思考' }
  ];
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => new Response(new ReadableStream({ start(controller) { const encoder = new TextEncoder(); events.forEach((event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } })
  });
  await assert.rejects(() => client.inputStream('iar-1', '查询状态'), (error: unknown) => error instanceof BridgeClientError && error.code === 'invalid_bridge_response');
});

test('IAR bridge client rejects oversized pass-through capability context', async () => {
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({
      version: PI_BRIDGE_VERSION,
      iarSessionId: 'iar-1',
      disposition: 'pass_through',
      capabilityContext: { functionDescriptors: Array.from({ length: 129 }, (_, index) => ({ functionId: `f-${index}`, pluginId: 'p', description: '可查询', actionTypes: ['query'] })) }
    })
  });
  await assert.rejects(() => client.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'invalid_bridge_response');
});

test('IAR bridge client rejects an unknown reply source', async () => {
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled', reply: '已处理', replySource: 'unknown' })
  });
  await assert.rejects(() => client.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'invalid_bridge_response');
});

test('IAR bridge client covers open, confirm, state and HTTP failure paths', async () => {
  const paths: string[] = [];
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async (input) => {
      const url = String(input);
      paths.push(url);
      if (url.endsWith('/sessions')) return Response.json({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-1', iarSessionId: 'iar-1', resumed: false }, { status: 201 });
      if (url.endsWith('/confirm')) return Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled', reply: '已取消' });
      if (url.endsWith('/state')) return Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1' });
      return new Response('unavailable', { status: 503 });
    }
  });
  assert.equal((await client.openSession({ piSessionId: 'pi-1' })).iarSessionId, 'iar-1');
  assert.equal((await client.confirm('iar-1', 'action-1', false)).reply, '已取消');
  assert.equal((await client.state('iar-1')).iarSessionId, 'iar-1');
  await assert.rejects(() => client.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'bridge_unavailable' && error.retryable);
  assert.deepEqual(paths, [
    'http://iar.test/api/bridge/v1/sessions',
    'http://iar.test/api/bridge/v1/sessions/iar-1/confirm',
    'http://iar.test/api/bridge/v1/sessions/iar-1/state',
    'http://iar.test/api/bridge/v1/sessions/iar-1/input'
  ]);
});

test('IAR bridge client rejects malformed responses and normalizes timeout failures', async () => {
  const malformed = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({ version: 'wrong', iarSessionId: 'iar-1', disposition: 'handled' })
  });
  await assert.rejects(() => malformed.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'invalid_bridge_response');

  const timedOut = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); }
  });
  await assert.rejects(() => timedOut.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'bridge_timeout' && error.retryable);
});

test('IAR bridge client applies the environment timeout when no explicit timeout is supplied', async () => {
  const previousTimeout = process.env.IAR_PI_BRIDGE_TIMEOUT_MS;
  process.env.IAR_PI_BRIDGE_TIMEOUT_MS = '5';
  let signal: AbortSignal | null | undefined;
  try {
    const client = new IarBridgeClient({
      baseUrl: 'http://iar.test',
      fetch: async (_input, options) => {
        signal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return Response.json({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'pass_through' });
      }
    });
    await client.input('iar-1', '普通问题');
    assert.equal(signal?.aborted, true);
  } finally {
    if (previousTimeout === undefined) delete process.env.IAR_PI_BRIDGE_TIMEOUT_MS;
    else process.env.IAR_PI_BRIDGE_TIMEOUT_MS = previousTimeout;
  }
});

test('IAR bridge client rejects an invalid environment timeout at construction', () => {
  const previousTimeout = process.env.IAR_PI_BRIDGE_TIMEOUT_MS;
  process.env.IAR_PI_BRIDGE_TIMEOUT_MS = 'not-a-duration';
  try {
    assert.throws(() => new IarBridgeClient({ baseUrl: 'http://iar.test' }), (error: unknown) => error instanceof BridgeClientError && error.code === 'invalid_bridge_timeout');
  } finally {
    if (previousTimeout === undefined) delete process.env.IAR_PI_BRIDGE_TIMEOUT_MS;
    else process.env.IAR_PI_BRIDGE_TIMEOUT_MS = previousTimeout;
  }
});

test('IAR bridge client preserves stable server error codes', async () => {
  const client = new IarBridgeClient({
    baseUrl: 'http://iar.test',
    fetch: async () => Response.json({ version: PI_BRIDGE_VERSION, code: 'session_busy', message: 'IAR 会话繁忙。', retryable: true }, { status: 503 })
  });
  await assert.rejects(() => client.input('iar-1', '普通问题'), (error: unknown) => error instanceof BridgeClientError && error.code === 'session_busy' && error.retryable);
});

test('Pi extension reports response model failures without poisoning the bridge session', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const notifications: string[] = [];
  let calls = 0;
  const client = {
    openSession: async () => ({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-1', iarSessionId: 'iar-1', resumed: false }),
    input: async () => {
      calls += 1;
      if (calls === 1) throw new BridgeClientError('response_model_failed', 'Response Model 处理失败。', true);
      return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled' as const, reply: '第二次请求成功' };
    },
    confirm: async () => { throw new Error('unreachable'); },
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1' })
  };
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: () => {},
    appendEntry: () => {},
    registerEntryRenderer: () => {}
  };
  await createIarExtension({ client })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(await handlers.get('input')?.({ text: '第一次请求', source: 'interactive' }, context), { action: 'handled' });
  assert.deepEqual(await handlers.get('input')?.({ text: '第二次请求', source: 'interactive' }, context), { action: 'handled' });
  assert.deepEqual(notifications, ['Response Model 处理失败，本轮未完成，未执行任何动作。']);
});

test('Pi extension continues pass-through and handles IAR results', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const commands = new Map<string, { handler: (args: string, context: PiExtensionContext) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const renderers = new Map<string, (entry: { data?: unknown }, options: { expanded: boolean }, theme: unknown) => { render(width: number): string[]; invalidate(): void } | undefined>();
  const notifications: string[] = [];
  let inputCalls = 0;
  const responses: BridgeInputResponse[] = [
    { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'pass_through' },
    { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'awaiting_confirmation', reply: '请确认', replySource: 'none', pending: { actionId: 'action-1', runId: 'run-1', functionId: 'f', pluginId: 'p', riskLevel: 'high', confirmationRequired: true } }
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
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    registerEntryRenderer: (customType, renderer) => { renderers.set(customType, renderer); }
  };
  await createIarExtension({ client: fakeClient })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(await handlers.get('input')?.({ text: '普通问题', source: 'interactive' }, context), { action: 'continue' });
  assert.deepEqual(await handlers.get('input')?.({ text: '执行动作', source: 'interactive' }, context), { action: 'handled' });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { customType: 'iar-bridge', data: { content: '请确认', disposition: 'awaiting_confirmation', replySource: 'none' } });
  assert.equal(renderers.has('iar-bridge'), true);
  const rendered = renderers.get('iar-bridge')?.({ data: entries[0]?.data }, { expanded: false }, {});
  assert.deepEqual(rendered?.render(80), ['[IAR awaiting_confirmation · none] 请确认']);
  const unsafe = renderers.get('iar-bridge')?.({ data: { content: `\u001b[31m${'x'.repeat(5000)}\u001b[0m`, disposition: 'handled' } }, { expanded: false }, {});
  assert.equal(unsafe?.render(80).some((line) => line.includes('\u001b')), false);
  assert.equal(unsafe?.render(80).join('').length <= 4096 + '[IAR handled] '.length, true);
  assert.deepEqual(await handlers.get('input')?.({ text: '由扩展注入', source: 'extension' }, context), { action: 'continue' });
  assert.equal(inputCalls, 2);
  await commands.get('iar-confirm')?.handler('', context);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1], { customType: 'iar-bridge', data: { content: 'action-1:true', disposition: 'confirmed' } });
  assert.deepEqual(notifications, []);
});

test('Pi extension fails closed when IAR is unavailable', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const notifications: string[] = [];
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: () => {},
    appendEntry: () => {},
    registerEntryRenderer: () => {}
  };
  const client = { openSession: async () => { throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true); }, input: async () => { throw new Error('unreachable'); }, confirm: async () => { throw new Error('unreachable'); }, state: async () => { throw new Error('unreachable'); } };
  await createIarExtension({ client })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(notifications, ['IAR 桥接不可用，当前输入已安全阻断。']);
  assert.deepEqual(await handlers.get('input')?.({ text: '业务请求', source: 'interactive' }, context), { action: 'handled' });
});

test('Pi extension forwards iar-cancel and clears the consumed pending actionId', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const commands = new Map<string, { handler: (args: string, context: PiExtensionContext) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const confirmations: Array<{ actionId: string; accepted: boolean }> = [];
  const fakeClient = {
    openSession: async () => ({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-1', iarSessionId: 'iar-1', resumed: true }),
    input: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'awaiting_confirmation' as const, reply: '请确认', pending: { actionId: 'action-9', runId: 'run-9', functionId: 'ticket.create', pluginId: 'ticket-create-v1', riskLevel: 'high', confirmationRequired: true } }),
    confirm: async (_sessionId: string, actionId: string, accepted: boolean) => { confirmations.push({ actionId, accepted }); return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'handled' as const, reply: '已取消该操作。' }; },
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1' })
  };
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: (name, definition) => { commands.set(name, definition); },
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    registerEntryRenderer: () => {}
  };
  await createIarExtension({ client: fakeClient })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: () => {} } };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(await handlers.get('input')?.({ text: '删除数据集', source: 'interactive' }, context), { action: 'handled' });
  await commands.get('iar-cancel')?.handler('', context);
  assert.deepEqual(confirmations, [{ actionId: 'action-9', accepted: false }]);
  assert.deepEqual(entries[1], { customType: 'iar-bridge', data: { content: '已取消该操作。', disposition: 'cancelled' } });
  // 待确认已消费；再次取消应提示而没有新的桥接调用。
  await commands.get('iar-cancel')?.handler('', context);
  assert.equal(confirmations.length, 1);
});

test('Pi extension presents clarification as handled and blocks the Pi Agent', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const fakeClient = {
    openSession: async () => ({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-1', iarSessionId: 'iar-1', resumed: false }),
    input: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1', disposition: 'clarification' as const, reply: '请补充工单标题。', reasonCode: 'needs_clarification' }),
    confirm: async () => { throw new Error('unreachable'); },
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-1' })
  };
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: () => {},
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    registerEntryRenderer: () => {}
  };
  await createIarExtension({ client: fakeClient })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) }, mode: 'rpc' as const };
  await handlers.get('session_start')?.({}, context);
  assert.deepEqual(await handlers.get('input')?.({ text: '提个工单', source: 'rpc' }, context), { action: 'handled' });
  assert.deepEqual(entries[0], { customType: 'iar-bridge', data: { content: '请补充工单标题。', disposition: 'clarification' } });
  assert.deepEqual(notifications, ['请补充工单标题。']);
});

test('Pi extension honors onUnavailable continue to fall through to the Pi Agent', async () => {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const notifications: string[] = [];
  const pi: PiExtensionAPI = {
    on: (event, handler) => { handlers.set(event, handler); },
    registerCommand: () => {},
    appendEntry: () => {},
    registerEntryRenderer: () => {}
  };
  const failingClient = { openSession: async () => { throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true); }, input: async () => { throw new Error('unreachable'); }, confirm: async () => { throw new Error('unreachable'); }, state: async () => { throw new Error('unreachable'); } };
  await createIarExtension({ client: failingClient, onUnavailable: 'continue' })(pi);
  const context = { sessionManager: { getSessionId: () => 'pi-1' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers.get('session_start')?.({}, context);
  // 启动失败即放行给 Pi Agent；启动期保留一次桥接故障告知。
  assert.deepEqual(await handlers.get('input')?.({ text: '业务请求', source: 'interactive' }, context), { action: 'continue' });
  assert.deepEqual(notifications, ['IAR 桥接不可用，当前输入已安全阻断。']);

  // 运行中桥接掉线同样放行，且后续输入不再重复通知。
  let calls = 0;
  const flakyClient = {
    openSession: async () => ({ version: PI_BRIDGE_VERSION, piSessionId: 'pi-2', iarSessionId: 'iar-2', resumed: false }),
    input: async () => { calls += 1; if (calls === 1) return { version: PI_BRIDGE_VERSION, iarSessionId: 'iar-2', disposition: 'handled' as const, reply: '已处理' }; throw new BridgeClientError('bridge_unavailable', 'IAR 不可用', true); },
    confirm: async () => { throw new Error('unreachable'); },
    state: async () => ({ version: PI_BRIDGE_VERSION, iarSessionId: 'iar-2' })
  };
  const handlers2 = new Map<string, (event: unknown, context: PiExtensionContext) => Promise<unknown> | unknown>();
  const pi2: PiExtensionAPI = {
    on: (event, handler) => { handlers2.set(event, handler); },
    registerCommand: () => {},
    appendEntry: () => {},
    registerEntryRenderer: () => {}
  };
  await createIarExtension({ client: flakyClient, onUnavailable: 'continue' })(pi2);
  const context2 = { sessionManager: { getSessionId: () => 'pi-2' }, ui: { notify: (message: string) => notifications.push(message) } };
  await handlers2.get('session_start')?.({}, context2);
  assert.deepEqual(await handlers2.get('input')?.({ text: '第一问', source: 'interactive' }, context2), { action: 'handled' });
  assert.deepEqual(await handlers2.get('input')?.({ text: '第二问', source: 'interactive' }, context2), { action: 'continue' });
  assert.deepEqual(notifications, ['IAR 桥接不可用，当前输入已安全阻断。']);
});
