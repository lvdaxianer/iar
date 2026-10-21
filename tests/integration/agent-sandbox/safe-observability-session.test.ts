/**
 * 验证直接会话的流式超时、主动取消和兼容链路标识。
 * 测试调用真实会话及 provider，网络使用本地替身。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import type { ModelProfileRegistry } from '@iar/decision';
import { MAX_MODEL_RESPONSE_BYTES } from '../../../examples/agent-sandbox/src/models/model-transport.js';
import type { PiAgentDelegate } from '../../../examples/agent-sandbox/src/models/pi-agent-delegate.js';
import { safeModelTraceId } from '../../../examples/agent-sandbox/src/safe-log.js';
import { createStreamRequest, createTestProvider, flushObservabilityLogs, observeAuditTraces, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

/** 传输层用例只锁定 IAR 模型链路，Pi 兜底以立即失败的委托旁路。
 * @returns 立即拒绝的 Pi 委托
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
function disabledPiAgentFactory(): PiAgentDelegate {
  return {
    run: () => Promise.reject(new Error('pi disabled in transport test')),
    recordHandledTurn: () => undefined,
    reset: () => undefined
  };
}

/** 流先交付可观察增量，再超过响应上限，以验证不完整结果处理。
 * @param state - 记录服务端是否取消上游流
 * @returns 测试用响应体
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function oversizedStream(state: { isCancelled: boolean }): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index++ === 0) controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial-private"}}]}\n\n'));
      else controller.enqueue(new Uint8Array(MAX_MODEL_RESPONSE_BYTES));
    },
    cancel() { state.isCancelled = true; }
  }));
}

/** 安装本地模型替身，语义失败时沿用真实的离线降级路径。
 * @param state - 记录上游流取消状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function installOversizedModel(state: { isCancelled: boolean }): void {
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body)) as { stream?: boolean; messages?: Array<{ content: string }> };
    if (payload.stream) return oversizedStream(state);
    // 语义模型按已有方式回退，回复模型返回超限响应。
    if (payload.messages?.[0]?.content.includes('iar.semantic-frame')) return new Response('', { status: 503 });
    return new Response(new Uint8Array(MAX_MODEL_RESPONSE_BYTES + 1));
  };
}

/** 未执行动作时，超限必须返回失败且 done 事件不能伪装为完整回复。
 * @param server - 使用超限模型替身的真实会话服务
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertOversizedFallback(server: Awaited<ReturnType<ObservabilityFixture['start']>>): Promise<void> {
  const normal = await server.session.turn('你好');
  const events: Array<{ type: string; text?: string }> = [];
  const streamed = await server.session.turnStreamed('你好', (event) => { events.push(event); });
  assert.ok(events.some((event) => event.type === 'delta' && event.text === 'partial-private'));
  assert.equal(normal.status, 'failed'); assert.doesNotMatch(normal.reply, /partial-private/);
  assert.equal(streamed.status, 'failed'); assert.doesNotMatch(streamed.reply, /partial-private/);
  assert.equal(streamed.reasonCode, 'model_response_too_large');
  assert.ok(events.some((event) => event.type === 'done' && JSON.stringify(event).includes('model_response_too_large')));
}

/** 动作已经执行时，超限只标记回复不完整，不能诱导用户重复动作。
 * @param server - 使用超限模型替身的真实会话服务
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertOversizedExecution(server: Awaited<ReturnType<ObservabilityFixture['start']>>): Promise<void> {
  const executedEvents: Array<{ type: string; text?: string }> = [];
  const normalExecuted = await server.session.turn('列出今天的集成任务');
  assert.equal(normalExecuted.status, 'executed');
  assert.equal((normalExecuted as { reasonCode?: string }).reasonCode, 'model_response_too_large');
  assert.match(normalExecuted.reply, /已执行/);
  const executed = await server.session.turnStreamed('列出今天的集成任务', (event) => executedEvents.push(event));
  assert.equal(executed.status, 'executed');
  assert.equal((executed as { reasonCode?: string }).reasonCode, 'model_response_too_large');
  assert.ok(executed.actionResult);
  assert.match(executed.reply, /已执行/);
  assert.ok(executedEvents.some((event) => event.type === 'delta' && event.text === 'partial-private'));
  assert.ok(executedEvents.some((event) => event.type === 'done' && JSON.stringify(event).includes('model_response_too_large')));
}

/** HTTP 可观察增量仍必须伴随失败原因，且截断内容不能进入历史。
 * @param server - 使用超限模型替身的真实会话服务
 * @param state - 上游流取消状态
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertOversizedHttpStream(server: Awaited<ReturnType<ObservabilityFixture['start']>>, state: { isCancelled: boolean }): Promise<void> {
  const httpStream = await server.app.inject({ method: 'POST', url: '/api/chat?stream=1', payload: { message: '列出今天的集成任务' } });
  assert.match(httpStream.body, /partial-private/);
  assert.match(httpStream.body, /model_response_too_large/);
  assert.match(httpStream.body, /"status":"executed"/);
  assert.equal(state.isCancelled, true);
  const messages = (server.session as unknown as { recentMessages: Array<{ text: string }> }).recentMessages;
  assert.ok(messages.every((message) => !message.text.includes('partial-private')));
}

test('模型响应超限时普通和流式会话明确失败，不保存截断增量', () => withObservabilityFixture(async (fixture) => {
  const state = { isCancelled: false }; installOversizedModel(state);
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await fixture.start({ mode: 'brain', port: address.port, piAgentFactory: disabledPiAgentFactory });
  await assertOversizedFallback(server);
  await assertOversizedExecution(server);
  await assertOversizedHttpStream(server, state);
}));

/**
 * 模拟普通模型失败、流式调用等待超时取消的响应。
 * 非流式路径返回 503，驱动会话使用本地兜底流程。
 * 流式路径等待 AbortSignal，避免引入真实外部模型依赖。
 * @param _url - 模型地址，测试中不访问
 * @param options - 模型请求及取消信号
 * @returns 本地替身响应或等待取消的 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function timeoutFetch(_url: string | URL | Request, options?: RequestInit): Promise<Response> {
  const payload = JSON.parse(String(options?.body)) as { stream?: boolean };
  // 非流式失败让会话继续进入流式兜底。
  if (!payload.stream) return new Response('response-private', { status: 503 });
  return await new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('timeout-private')));
  });
}

/**
 * 两个实际会话流式分支都应记录超时而不是主动取消。
 * 注册表只覆盖测试中的回复超时时间，其他配置保持不变。
 * 分别触发澄清兜底和执行结果回复这两个真实路径。
 * 日志映射还应与网关返回的业务审计链路一致。
 * @param fixture - 隔离服务和日志的本地夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSessionTimeouts(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = timeoutFetch;
  const server = await fixture.start({ mode: 'brain', port: 29885, piAgentFactory: disabledPiAgentFactory });
  const auditTraces = observeAuditTraces(server);
  const registry = (server.session as unknown as { registry: ModelProfileRegistry }).registry;
  const original = registry.forRole.bind(registry);
  registry.forRole = (...args: Parameters<ModelProfileRegistry['forRole']>) => {
    const profile = original(...args);
    return profile.role === 'response.generate' ? { ...profile, timeoutMs: 5 } : profile;
  };
  assert.equal((await server.session.turnStreamed('你好', () => {})).status, 'clarification');
  assert.equal((await server.session.turnStreamed('列出今天的集成任务', () => {})).status, 'executed');
  await flushObservabilityLogs();
  const records = fixture.records();
  assert.equal(records.filter((record) => record.event === 'model.http' && record.outcome === 'timeout').length, 2);
  assert.ok(records.filter((record) => record.outcome === 'timeout').every((record) =>
    auditTraces.some((trace) => safeModelTraceId(trace) === record.traceId)));
  assert.equal(records.some((record) => record.event === 'model.http' && record.outcome === 'aborted'), false);
  assert.doesNotMatch(fixture.lines.join('\n'), /timeout-private|response-private|key-private/);
}

test('真实会话流式兜底与动作回复超时均记录 timeout', () => withObservabilityFixture(checkSessionTimeouts));

/**
 * 直接流式调用使用主动取消时，不能误判为超时。
 * fetch 替身在收到取消信号时抛出含敏感哨兵的异常。
 * 调用者主动发出默认取消原因，不使用 TimeoutError。
 * 异步日志排空后分别验证分类互斥和敏感信息过滤。
 * @param fixture - 捕获模型日志的隔离夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkProviderCancellation(fixture: ObservabilityFixture): Promise<void> {
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('cancel-private')));
  });
  const pending = createTestProvider().completeStreamed({ ...createStreamRequest(), signal: controller.signal }, () => {});
  controller.abort();
  await assert.rejects(pending);
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.outcome === 'aborted'));
  assert.equal(fixture.records().some((record) => record.outcome === 'timeout'), false);
  assert.doesNotMatch(fixture.lines.join('\n'), /cancel-private|prompt-private|key-private/);
}

test('流式模型主动取消仍记录 aborted 而非 timeout', () => withObservabilityFixture(checkProviderCancellation));

/**
 * 无 HTTP 入口时，公开业务审计仍保留已有会话链路标识。
 * 使用真实 scripted 会话和网关，不模拟业务审计结果。
 * 先验证审计非空，再检查每个条目的旧标识。
 * @param fixture - scripted 模式的本地服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkLegacyTrace(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29888 });
  const traces = observeAuditTraces(server);
  await server.session.turn('你好');
  assert.ok(traces.length > 0);
  assert.ok(traces.every((trace) => trace === 'trace-sandbox-1'));
}

test('非 HTTP 会话仍使用原有业务链路标识', () => withObservabilityFixture(checkLegacyTrace));

/**
 * 安装测试控制器并在流式请求发出后主动取消。
 * 普通调用返回 503，确保会话进入流式兜底路径。
 * 测试记录每个控制器，按当前请求信号找到对应实例。
 * 必须在 finally 恢复全局构造器，避免影响其他用例。
 * @param controllers - 记录会话创建的取消控制器
 * @returns 还原原始控制器构造器的函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function installSessionCancellation(controllers: AbortController[]): () => void {
  const original = globalThis.AbortController;
  globalThis.AbortController = class extends original {
    /** 保存会话控制器供测试主动取消。 @author lvdaxianer@yeah.net @date 2026-10-18 */
    constructor() { super(); controllers.push(this); }
  };
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body)) as { stream?: boolean };
    // 只对流式回复触发主动取消。
    if (!payload.stream) return new Response('response-private', { status: 503 });
    return await new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('cancel-private')));
      const controller = controllers.find((item) => item.signal === options?.signal);
      // 未找到对应信号时立即失败，避免测试假绿。
      if (!controller) throw new Error('missing session controller');
      queueMicrotask(() => controller.abort());
    });
  };
  return () => { globalThis.AbortController = original; };
}

/**
 * 检查真实会话流式调用被主动取消时输出 aborted。
 * 超时和主动取消的日志分类必须互斥。
 * 即使流式调用被取消，会话仍返回原有澄清结果。
 * @param fixture - 捕获会话日志的本地服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSessionCancellation(fixture: ObservabilityFixture): Promise<void> {
  const restore = installSessionCancellation([]);
  try {
    const server = await fixture.start({ mode: 'brain', port: 29887, piAgentFactory: disabledPiAgentFactory });
    assert.equal((await server.session.turnStreamed('你好', () => {})).status, 'clarification');
    await flushObservabilityLogs();
    const records = fixture.records();
    assert.equal(records.filter((record) => record.event === 'model.http' && record.outcome === 'aborted').length, 1);
    assert.equal(records.some((record) => record.outcome === 'timeout'), false);
    assert.doesNotMatch(fixture.lines.join('\n'), /cancel-private|response-private|key-private/);
  } finally { restore(); }
}

test('真实会话流式调用主动取消仍记录 aborted', () => withObservabilityFixture(checkSessionCancellation));
