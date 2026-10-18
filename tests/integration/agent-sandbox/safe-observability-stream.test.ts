/**
 * 验证流式模型调用的输出时机、失败分类和脱敏边界。
 * 所有模型响应由本地 fetch 替身提供，不访问真实模型。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLogIsIdleForTesting } from '../../../examples/agent-sandbox/src/safe-log.js';
import { createStreamRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

/**
 * 验证模型流未结束时没有提交成功日志，结束后输出安全调试记录。
 * 使用本地服务注册信号处理器，并在收到正文前后分别检查。
 * 这样既验证结果时机，也验证正文和连接密钥的脱敏。
 * @param fixture - 隔离日志、模型连接和本地服务的测试夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkStreamCompletion(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"response-private"}}]}\n\ndata: [DONE]\n\n');
  await fixture.start({ mode: 'scripted', port: 29879 });
  process.emit('SIGHUP');
  const output = await createTestProvider().completeStreamed(createStreamRequest(), () => {
    // 同时检查接收器为空，防止仅因异步投递而遗漏提前入队的日志。
    assert.equal(safeLogIsIdleForTesting(), true);
    assert.equal(fixture.lines.filter((line) => line.includes('"event":"model.http"')).length, 0);
  });
  assert.equal(output, 'response-private');
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'debug'));
  assert.doesNotMatch(fixture.lines.join('\n'), /response-private|prompt-private|key-private/);
}

test('流式模型日志在读取结束后输出而且不记录正文', () => withObservabilityFixture(checkStreamCompletion));

/**
 * 验证流读取故障会产生安全警告，异常原文不会进入日志。
 * 流的 pull 回调注入失败，覆盖响应头之后的读取阶段。
 * 日志排空后检查警告，避免误将异步延迟视为成功。
 * @param fixture - 捕获安全日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkStreamReadFailure(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull: (controller) => { controller.error(new Error('stream-private')); }
  }));
  await assert.rejects(createTestProvider().completeStreamed(createStreamRequest(), () => {}));
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'warn'));
  assert.doesNotMatch(fixture.lines.join('\n'), /stream-private|prompt-private|key-private/);
}

test('流式读取中断输出警告且不记录异常文本', () => withObservabilityFixture(checkStreamReadFailure));

/**
 * 验证超时取消原因被识别为固定枚举，且不会输出原始异常。
 * fetch 替身只在收到取消信号后拒绝，不使用外部模型。
 * 取消理由中的敏感哨兵用于检测异常内容泄露。
 * @param fixture - 捕获安全日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkTimeout(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('timeout-private')));
  });
  const controller = new AbortController();
  const pending = createTestProvider().complete({ ...createStreamRequest(), signal: controller.signal });
  controller.abort(new DOMException('timeout-private', 'TimeoutError'));
  await assert.rejects(pending);
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'warn' && record.outcome === 'timeout'));
  assert.doesNotMatch(fixture.lines.join('\n'), /timeout-private|prompt-private|key-private/);
}

test('模型调用超时输出安全分类', () => withObservabilityFixture(checkTimeout));

/**
 * 同时覆盖连接失败和 HTTP 错误，确认两次调用各产生一条警告。
 * 两种响应均由同一个 provider 调用，避免环境差异影响断言。
 * 非成功响应正文和连接异常均不应出现在日志中。
 * @param fixture - 捕获安全日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkStreamFailures(fixture: ObservabilityFixture): Promise<void> {
  const provider = createTestProvider();
  globalThis.fetch = async () => { throw new Error('network-private'); };
  await assert.rejects(provider.completeStreamed(createStreamRequest(), () => {}));
  globalThis.fetch = async () => new Response('response-private', { status: 503 });
  await assert.rejects(provider.completeStreamed(createStreamRequest(), () => {}));
  await flushObservabilityLogs();
  assert.equal(fixture.records().filter((record) => record.event === 'model.http' && record.level === 'warn').length, 2);
  assert.doesNotMatch(fixture.lines.join('\n'), /network-private|response-private|prompt-private|key-private/);
}

test('流式连接失败和非成功 HTTP 状态均产生警告', () => withObservabilityFixture(checkStreamFailures));

/**
 * 普通响应格式无效和流式响应无正文都应被识别为失败。
 * 普通响应返回非法 JSON，流式响应只包含结束标记。
 * 两次失败各应产生一条警告，且原始正文不能泄露。
 * @param fixture - 捕获安全日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkInvalidResponse(fixture: ObservabilityFixture): Promise<void> {
  const provider = createTestProvider();
  globalThis.fetch = async () => new Response('invalid-private');
  await assert.rejects(provider.complete(createStreamRequest()));
  globalThis.fetch = async () => new Response('data: [DONE]\n\n');
  await assert.rejects(provider.completeStreamed(createStreamRequest(), () => {}));
  await flushObservabilityLogs();
  assert.equal(fixture.records().filter((record) => record.event === 'model.http' && record.level === 'warn').length, 2);
  assert.doesNotMatch(fixture.lines.join('\n'), /invalid-private|prompt-private|key-private/);
}

test('模型响应无有效内容时记录失败', () => withObservabilityFixture(checkInvalidResponse));
