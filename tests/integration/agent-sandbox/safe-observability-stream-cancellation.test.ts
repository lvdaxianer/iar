/**
 * 验证 SSE 入口、取消和真实网关超时的安全审计。
 * 网络响应和模型均为本地确定性替身。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { ModelGateway, ModelProfileRegistry } from '@iar/decision';
import { createStreamRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

/**
 * 在完整 SSE 响应结束后查找 HTTP 结束审计。
 * 服务采用 scripted 模式，避免依赖任何模型网络。
 * @param fixture - 隔离进程状态的服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSseEnd(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29881 });
  const response = await server.app.inject({ method: 'POST', url: '/api/chat?stream=1', payload: { message: '你好' } });
  assert.equal(response.statusCode, 200);
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'http.request.end' && record.status === 200));
}

test('SSE 响应完成后输出请求结束审计', () => withObservabilityFixture(checkSseEnd));

/**
 * 验证结构化模型正文不能解析时记录固定失败类型。
 * 响应包含敏感哨兵，用于检测原始正文是否泄露。
 * @param fixture - 捕获模型传输日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkInvalidContent(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'content-private' } }] });
  await assert.rejects(createTestProvider().complete(createStreamRequest()));
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.outcome === 'invalid_response'));
  assert.doesNotMatch(fixture.lines.join('\n'), /content-private|prompt-private|key-private/);
}

test('结构化模型正文无效时记录失败', () => withObservabilityFixture(checkInvalidContent));

/**
 * 有界等待真实本地连接的入口审计开始。
 * 避免固定睡眠造成慢速环境下的测试竞争。
 * @param fixture - 捕获 HTTP 日志的夹具
 * @returns 开始记录出现后完成
 * @throws Error 超过一秒仍未收到入口日志时失败
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function waitForStart(fixture: ObservabilityFixture): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!fixture.lines.some((line) => line.includes('http.request.start'))) {
    // 即使入口审计未出现，测试也必须在固定期限内退出。
    if (Date.now() >= deadline) throw new Error('缺少请求开始审计');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 用未发送完整请求体的真实 socket 验证提前断开审计。
 * 先观察入口记录，再销毁连接，确保测试发生在处理期间。
 * @param fixture - 捕获 HTTP 日志的本地服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkClientDisconnect(fixture: ObservabilityFixture): Promise<void> {
  await fixture.start({ mode: 'scripted', port: 29882 });
  const socket = connect(29882, '127.0.0.1');
  try {
    socket.write('POST /api/chat HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');
    await waitForStart(fixture);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flushObservabilityLogs();
    assert.ok(fixture.records().some((record) => record.event === 'http.request.end' && record.outcome === 'aborted'));
  } finally { socket.destroy(); }
}

test('客户端中断请求时仍记录结束审计', () => withObservabilityFixture(checkClientDisconnect));

/**
 * 模拟普通响应正文读取期间收到超时取消。
 * 即使流抛出敏感错误，也应只输出固定 timeout 分类。
 * @param fixture - 捕获模型传输日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkBodyTimeout(fixture: ObservabilityFixture): Promise<void> {
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start: (stream) => { controller.signal.addEventListener('abort', () => stream.error(new Error('body-private'))); }
  }));
  const pending = createTestProvider().complete({ ...createStreamRequest(), signal: controller.signal });
  controller.abort(new DOMException('timeout-private', 'TimeoutError'));
  await assert.rejects(pending);
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.outcome === 'timeout'));
  assert.doesNotMatch(fixture.lines.join('\n'), /body-private|timeout-private|prompt-private|key-private/);
}

test('普通响应读取期间超时按取消信号分类', () => withObservabilityFixture(checkBodyTimeout));

/**
 * 使用真实网关和 provider 验证超时的公开契约及传输分类。
 * fetch 替身等待网关取消信号，不发送真实外部模型请求。
 * @param fixture - 捕获模型传输日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkGatewayTimeout(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('gateway-timeout-private')));
  });
  const profile = { ...createStreamRequest().profile, profileVersion: '1.0.0', timeoutMs: 5,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] } };
  const gateway = new ModelGateway({ registry: new ModelProfileRegistry([profile]), providers: { brain: createTestProvider() } });
  const result = await gateway.invoke('response.generate',
    { traceId: 'trace-test', runId: 'run-test', input: { userMessage: 'prompt-private' } }, (value) => ({ ok: true, value }));
  assert.equal(result.ok, false);
  // 失败分支还需核对对外错误详情，不能只检查日志分类。
  if (!result.ok) assert.deepEqual(result.error, { code: 'model.timeout', message: '模型调用超时', retryable: true, details: {} });
  assert.equal(result.audit[0]?.outcome, 'timeout');
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'warn' && record.outcome === 'timeout'));
  assert.doesNotMatch(fixture.lines.join('\n'), /gateway-timeout-private|prompt-private|key-private/);
}

test('真实模型网关超时保留公开错误并输出安全超时日志', () => withObservabilityFixture(checkGatewayTimeout));
