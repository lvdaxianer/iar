/**
 * 验证 HTTP 入口、业务审计和传输日志的并发链路隔离。
 * 还覆盖 SSE 失败及客户端断开的独立安全分类。
 * 实际本地 Fastify 响应可触发异步写入错误及响应终止。
 * 记录中不得包含模拟异常、消息或模型响应的敏感哨兵。
 * 多条日志以服务生成的链路标识关联，而非用户输入。
 * 网络操作仅连接本机测试服务，不访问真实外部模型。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import type { SandboxServerHandle } from '../../../examples/agent-sandbox/src/server.js';
import { flushObservabilityLogs, observeAuditTraces, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

/**
 * 检查并发请求各自的入口、网关审计和模型传输记录。
 * 流式响应返回 418，便于从普通模型调用中识别。
 * 三个入口并发执行，并采用不同 trace 标识。
 * 模型响应全部来自本地替身，不访问外部服务。
 * @param fixture - 处理并发请求的本地服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkConcurrentTraces(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(String(options?.body)) as { stream?: boolean };
    return new Response('response-private', { status: payload.stream ? 418 : 503 });
  };
  const server = await fixture.start({ mode: 'brain', port: 29884 });
  const traces = observeAuditTraces(server);
  await Promise.all([false, true, false].map((stream) => server.app.inject({
    method: 'POST', url: '/api/chat', payload: { message: 'prompt-private', stream }
  })));
  await flushObservabilityLogs();
  assertConcurrentTraces(fixture, traces);
}

/**
 * 验证每个并发入口都有对应审计及传输日志。
 * 同时检查流式传输与敏感数据过滤，防止只测试普通调用。
 * @param fixture - 已收集日志的服务夹具
 * @param traces - 真实网关返回的业务审计标识
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function assertConcurrentTraces(fixture: ObservabilityFixture, traces: string[]): void {
  const records = fixture.records();
  const starts = records.filter((record) => record.event === 'http.request.start');
  assert.equal(starts.length, 3);
  assert.equal(new Set(starts.map((start) => start.traceId)).size, 3);
  for (const start of starts) {
    assert.ok(traces.includes(String(start.traceId)), '业务模型审计必须关联入口 trace');
    assert.ok(records.some((record) => record.event === 'model.http' && record.traceId === start.traceId));
  }
  const streamLog = records.find((record) => record.event === 'model.http' && record.status === 418);
  assert.ok(streamLog && starts.some((start) => start.traceId === streamLog.traceId), '流式传输必须关联入口');
  assert.ok(traces.includes(String(streamLog.traceId)), '流式传输必须关联业务模型审计');
  assert.doesNotMatch(fixture.lines.join('\n'), /response-private|prompt-private|key-private/);
}

test('并发普通和流式请求的网关审计与传输日志沿用各自入口 trace', () => withObservabilityFixture(checkConcurrentTraces));

/**
 * 正常 SSE 流不得产生 stream_failed，异常流必须额外记录失败。
 * 状态码保持 200，因为发送异常时响应头已经发出。
 * 先清空正常请求日志，再独立检查失败请求。
 * 会话抛出的原始异常不得进入安全日志。
 * @param fixture - 捕获入口和 SSE 日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSseFailure(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29883 });
  const normal = await server.app.inject({ method: 'POST', url: '/api/chat?stream=1', payload: { message: '你好' } });
  assert.equal(normal.statusCode, 200);
  await flushObservabilityLogs();
  assert.equal(fixture.records().some((record) => record.outcome === 'stream_failed'), false);
  fixture.lines.length = 0;
  server.session.turnStreamed = async () => { throw new Error('exception-private'); };
  const failed = await server.app.inject({ method: 'POST', url: '/api/chat?stream=1', payload: { message: 'prompt-private' } });
  assert.equal(failed.statusCode, 200);
  assert.match(failed.body, /stream_failed/);
  await flushObservabilityLogs();
  assertSseFailure(fixture);
}

/**
 * 检查流失败日志和入口记录的标识及保密性。
 * @param fixture - 已收集失败请求日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function assertSseFailure(fixture: ObservabilityFixture): void {
  const start = fixture.records().find((record) => record.event === 'http.request.start');
  const failure = fixture.records().find((record) => record.event === 'http.stream' && record.outcome === 'stream_failed');
  assert.ok(start && failure, 'SSE 会话失败应写入安全日志');
  assert.equal(failure.traceId, start.traceId);
  assert.equal(failure.requestId, start.requestId);
  assert.equal(failure.level, 'warn');
  assert.doesNotMatch(fixture.lines.join('\n'), /exception-private|prompt-private/);
}

test('SSE 会话异常产生关联的安全失败记录而正常流不产生失败记录', () => withObservabilityFixture(checkSseFailure));

/**
 * 有界等待客户端断开审计输出，不依赖同步日志投递。
 * 轮询的每次让出事件循环，允许异步写入完成。
 * 超过一秒直接失败，防止测试无限期挂起。
 * @param fixture - 捕获 HTTP 记录的夹具
 * @returns 断开审计出现后完成
 * @throws Error 超过期限仍无断开记录
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function waitForDisconnect(fixture: ObservabilityFixture): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!fixture.records().some((record) => record.outcome === 'aborted')) {
    // 如果客户端断开没有被审计，按固定期限失败。
    if (Date.now() >= deadline) throw new Error('missing close audit');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 真实客户端收到 SSE 数据后断开连接，检查关联的结束审计。
 * 会话保持挂起直到断言结束，避免把主动断开误判为流失败。
 * finally 始终释放测试会话和 socket，避免泄漏资源。
 * @param fixture - 本地服务和日志夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSseDisconnect(fixture: ObservabilityFixture): Promise<void> {
  let releaseTurn: () => void = () => {};
  const pending = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const server = await fixture.start({ mode: 'scripted', port: 29886 });
  server.session.turnStreamed = async (_text, emit) => {
    emit({ type: 'stage', stage: 'semantic' });
    await pending;
    return { status: 'failed', reply: '', reasonCode: 'test', route: { status: 'failed', reasonCode: 'test', semanticIntent: 'unknown', semanticConfidence: 0 } };
  };
  const socket = connect(29886, '127.0.0.1');
  try {
    socket.write('POST /api/chat?stream=1 HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"message":"x"}');
    await new Promise<void>((resolve, reject) => { socket.once('data', () => resolve()); socket.once('error', reject); });
    socket.destroy();
    await waitForDisconnect(fixture);
    assertDisconnect(fixture);
  } finally { socket.destroy(); releaseTurn(); }
}

/**
 * 检查断开状态与入口链路，并确保没有误记流失败。
 * @param fixture - 已捕获断开审计的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function assertDisconnect(fixture: ObservabilityFixture): void {
  const records = fixture.records();
  const start = records.find((record) => record.event === 'http.request.start');
  const end = records.find((record) => record.event === 'http.request.end' && record.outcome === 'aborted');
  assert.ok(start && end);
  assert.equal(end.traceId, start.traceId);
  assert.equal(end.status, 499);
  assert.equal(records.some((record) => record.outcome === 'stream_failed'), false);
}

test('SSE 响应中途断开产生关联的断开审计而不误报会话失败', () => withObservabilityFixture(checkSseDisconnect));

/**
 * 通过真实 Fastify 响应模拟异步写入失败，包含 destroyed 已为真的情况。
 * 同一响应发出重复和迟到错误，不由测试安装额外的错误监听器。
 * 请求结束审计不能误报 200 成功，所有记录必须关联入口链路。
 * @param fixture - 隔离的安全日志夹具
 * @returns 回归检查完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkRealAsyncWriteFailure(fixture: ObservabilityFixture): Promise<void> {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const server = await fixture.start({ mode: 'scripted', port: address.port });
  let release = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
  server.session.turnStreamed = async (_text, emit) => {
    emit({ type: 'stage', stage: 'semantic' }); await gate;
    return { status: 'failed', reply: '', reasonCode: 'test', route: { status: 'failed', reasonCode: 'test', semanticIntent: 'unknown', semanticConfidence: 0 } };
  };
  await sendRealAsyncFailure(server, address.port, release);
  await flushObservabilityLogs(); assertRealAsyncFailure(fixture);
}

/**
 * 在真实服务响应上触发先于断开的异步错误与迟到错误。
 * @param server - 已监听的本地服务
 * @param port - 服务端口
 * @param release - 结束受控会话的函数
 * @returns 客户端连接结束后完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function sendRealAsyncFailure(server: SandboxServerHandle, port: number, release: () => void): Promise<void> {
  const captured = new Promise<import('node:http').ServerResponse>((resolve) => server.app.server.prependOnceListener('request', (_req, res) => resolve(res)));
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('POST /api/chat?stream=1 HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"message":"x"}');
    const raw = await captured; await once(socket, 'data', { signal: AbortSignal.timeout(2000) });
    Object.defineProperty(raw, 'destroyed', { configurable: true, value: true });
    raw.emit('error', new Error('private-async-error'));
    raw.emit('error', new Error('private-async-error'));
    delete (raw as unknown as { destroyed?: boolean }).destroyed;
    raw.destroy(); release(); await once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    raw.emit('error', new Error('private-async-error'));
  } finally { socket.destroy(); release(); }
}

/**
 * 验证实际 HTTP 请求只产生一条失败与一条非成功结束审计。
 * @param fixture - 已捕获日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function assertRealAsyncFailure(fixture: ObservabilityFixture): void {
  const records = fixture.records();
  const start = records.find((record) => record.event === 'http.request.start');
  const failures = records.filter((record) => record.event === 'http.stream' && record.outcome === 'stream_write_failed');
  const ends = records.filter((record) => record.event === 'http.request.end');
  assert.ok(start); assert.equal(failures.length, 1, JSON.stringify(records)); assert.equal(ends.length, 1);
  assert.equal(failures[0]?.traceId, start.traceId); assert.equal(ends[0]?.traceId, start.traceId);
  assert.equal(ends[0]?.outcome, 'stream_write_failed'); assert.equal(ends[0]?.status, 500);
  assert.doesNotMatch(fixture.lines.join('\n'), /private-async-error/);
}

test('真实 Fastify 异步写入失败不会审计为成功或客户端断开', { timeout: 5000 }, () => withObservabilityFixture(checkRealAsyncWriteFailure));
