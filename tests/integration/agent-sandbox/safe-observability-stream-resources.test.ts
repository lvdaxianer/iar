/**
 * 验证失败响应与流读取时的资源释放和日志分类。
 * 所有 fetch 均为本地替身，不访问真实模型服务。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelProviderError } from '../../../packages/decision/src/model-gateway/index.js';
import { createStreamRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

/**
 * 判定普通响应失败是否保留 provider_failed 契约。
 * @param error - 调用拒绝时捕获的错误
 * @returns 是否匹配稳定错误分类
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function isProviderFailure(error: unknown): boolean {
  return error instanceof ModelProviderError && error.kind === 'provider_failed';
}

/**
 * 检验非 2xx 普通及流式响应都会取消正文。
 * cancel 故意永不完成，业务应仍在有限时间内返回原错误。
 * 两种调用共用一个响应替身，分别确认每个响应体被取消。
 * 如果清理阻塞，超时哨兵不能通过错误类型断言。
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkHttpResourceRelease(): Promise<void> {
  const provider = createTestProvider();
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel: () => { cancelled += 1; return new Promise<void>(() => {}); }
  }), { status: 503 });
  for (const invoke of [() => provider.complete(createStreamRequest()), () => provider.completeStreamed(createStreamRequest(), () => {})]) {
    const result = await Promise.race([invoke().catch((error: unknown) => error), new Promise((resolve) => setTimeout(() => resolve('blocked'), 100))]);
    assert.ok(isProviderFailure(result));
  }
  assert.equal(cancelled, 2, '每个非成功响应体都应取消');
}

test('普通和流式 HTTP 错误取消响应体且不等待未完成的取消', () => withObservabilityFixture(checkHttpResourceRelease));

/**
 * 流式回调抛错时必须取消流并释放 reader 锁。
 * cancel 永不返回，确保调用方不会等待清理完成。
 * 消费回调抛出错误后，输出内容和原始异常都不参与返回。
 * 同时保留 provider_unavailable 的现有对外错误分类。
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkCallbackFailure(): Promise<void> {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"private"}}]}\n\n')); },
    cancel: () => { cancelled = true; return new Promise<void>(() => {}); }
  });
  globalThis.fetch = async () => new Response(body);
  const pending = createTestProvider().completeStreamed(createStreamRequest(), () => { throw new Error('callback-private'); });
  const result = await Promise.race([pending.catch((error: unknown) => error), new Promise((resolve) => setTimeout(() => resolve('blocked'), 100))]);
  assert.ok(result instanceof ModelProviderError && result.kind === 'provider_unavailable');
  assert.equal(cancelled, true, '回调失败应取消流');
  assert.equal(body.locked, false, '回调失败应释放 reader 锁');
}

test('流式回调异常时取消响应体并释放锁而不等待取消', () => withObservabilityFixture(checkCallbackFailure));

/**
 * 同时验证读取失败和正常结束后的流锁释放。
 * 失败错误契约及正常内容结果都必须保持不变。
 * 失败和成功使用不同的内存流，分别检查锁状态。
 * 两次调用都通过同一个 provider 完成。
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkReaderLocks(): Promise<void> {
  const provider = createTestProvider();
  const failed = new ReadableStream<Uint8Array>({ pull: (controller) => { controller.error(new Error('read-private')); } });
  const completed = new ReadableStream<Uint8Array>({ start: (controller) => {
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
    controller.close();
  } });
  globalThis.fetch = async () => new Response(failed);
  await assert.rejects(provider.completeStreamed(createStreamRequest(), () => {}),
    (error: unknown) => error instanceof ModelProviderError && error.kind === 'provider_unavailable');
  assert.equal(failed.locked, false, '读取失败应释放 reader 锁');
  globalThis.fetch = async () => new Response(completed);
  assert.equal(await provider.completeStreamed(createStreamRequest(), () => {}), 'ok');
  assert.equal(completed.locked, false, '正常结束应释放 reader 锁');
}

test('流读取失败及正常结束均释放 reader 锁', () => withObservabilityFixture(checkReaderLocks));

/**
 * 按顺序注入正文读取故障、非法 JSON 和主动取消。
 * 所有调用保持同一种对外错误，区别只体现在安全分类。
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function invokeBodyFailures(): Promise<void> {
  const provider = createTestProvider();
  globalThis.fetch = async () => new Response(new ReadableStream({ pull: (stream) => { stream.error(new Error('read-private')); } }));
  await assert.rejects(provider.complete(createStreamRequest()), isProviderFailure);
  globalThis.fetch = async () => new Response('invalid-json-private');
  await assert.rejects(provider.complete(createStreamRequest()), isProviderFailure);
  const controller = new AbortController();
  globalThis.fetch = async () => new Response(new ReadableStream({ start: (stream) => {
    controller.signal.addEventListener('abort', () => stream.error(new Error('cancel-private')));
  } }));
  const cancelled = provider.complete({ ...createStreamRequest(), signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, isProviderFailure);
}

/**
 * 检查正文失败的三种枚举顺序和敏感内容过滤。
 * 等待异步队列排空后才校验，避免遗漏尾部记录。
 * @param fixture - 捕获安全日志的隔离夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkBodyFailures(fixture: ObservabilityFixture): Promise<void> {
  await invokeBodyFailures();
  await flushObservabilityLogs();
  assert.deepEqual(fixture.records().map((record) => record.outcome), ['network_error', 'invalid_response', 'aborted']);
  assert.doesNotMatch(fixture.lines.join('\n'), /read-private|invalid-json-private|cancel-private|prompt-private|key-private/);
}

test('普通响应区分网络读取失败、非法 JSON 和主动取消', () => withObservabilityFixture(checkBodyFailures));
