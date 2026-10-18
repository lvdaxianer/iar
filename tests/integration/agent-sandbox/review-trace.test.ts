/**
 * 验证直接模型调用的敏感标识与嵌套异步上下文。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { safeModelTraceId } from '../../../examples/agent-sandbox/src/safe-log.js';
import { createSemanticRequest, createStreamRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture } from './observability-fixture.js';

/**
 * 执行普通或流式调用，并断言固定的本地 HTTP 失败。
 * @param traceId - 不可信业务标识
 * @param stream - 是否使用流式接口
 * @returns 调用结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function failCall(traceId: string, stream: boolean): Promise<void> {
  const provider = createTestProvider();
  const request = { ...(stream ? createStreamRequest() : createSemanticRequest()), traceId };
  await assert.rejects(stream ? provider.completeStreamed(request, () => {}) : provider.complete(request));
}

/**
 * UUID 形状不能证明输入可信；普通和流式调用都不得输出原文。
 * 固定 503 避免真实外部服务及响应内容进入测试。
 * 两个调用使用相同业务标识，映射结果须一致。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('直接普通与流式调用映射 UUID 形状的秘密', async () => {
  await withObservabilityFixture(async (fixture) => {
    const secret = '15bb85f1-191d-4d7b-b2d7-ea6f01324f6a';
    globalThis.fetch = async () => new Response('', { status: 503 });
    await failCall(secret, false);
    await failCall(secret, true);
    await flushObservabilityLogs();
    const traces = fixture.records().map((entry) => entry.traceId);
    assert.equal(traces.length, 2);
    assert.ok(traces.every((trace) => trace === safeModelTraceId(secret) && trace !== secret));
    assert.ok(!fixture.lines.join('\n').includes(secret));
  });
});

/**
 * 在外层 fetch 期间发起另一模型调用，确认两层上下文隔离。
 * @param outerStream - 外层是否为流式调用
 * @returns 验证结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkNested(outerStream: boolean): Promise<void> {
  await withObservabilityFixture(async (fixture) => {
    let count = 0;
    globalThis.fetch = async () => {
      count += 1;
      if (count === 1) await failCall('inner-private', !outerStream);
      return new Response('', { status: 503 });
    };
    await failCall('outer-private', outerStream);
    await flushObservabilityLogs();
    assert.deepEqual(fixture.records().map((entry) => entry.traceId),
      [safeModelTraceId('inner-private'), safeModelTraceId('outer-private')]);
  });
}

/** 两种嵌套方向均必须隔离，不能借用外层模型上下文。 */
test('普通调用嵌套流式调用时链路隔离', async () => { await checkNested(false); });
/** 流式外层也不能覆盖内层普通调用的业务链路。 */
test('流式调用嵌套普通调用时链路隔离', async () => { await checkNested(true); });

/**
 * 并发调用交错完成时不能相互覆盖各自映射链路。
 * 每次请求均以本地确定性失败触发传输日志。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('并发普通及流式直接调用保持各自链路', async () => {
  await withObservabilityFixture(async (fixture) => {
    globalThis.fetch = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return new Response('', { status: 503 }); };
    await Promise.all([failCall('one-private', false), failCall('two-private', true)]);
    await flushObservabilityLogs();
    assert.deepEqual(new Set(fixture.records().map((entry) => entry.traceId)),
      new Set([safeModelTraceId('one-private'), safeModelTraceId('two-private')]));
  });
});
