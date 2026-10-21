/**
 * 验证非 HTTP 模型调用的安全链路关联。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture } from './observability-fixture.js';
import { registerDebugSignal, safeModelTraceId } from '../../../examples/agent-sandbox/src/safe-log.js';
import { ModelGateway, ModelProfileRegistry } from '@iar/runtime';

/**
 * 创建流式角色请求，保留既有固定测试连接。
 * @param traceId - 供测试验证的业务链路标识
 * @returns 使用响应生成角色的模型请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function streamRequest(traceId: string) {
  const request = createSemanticRequest();
  return { ...request, traceId, profile: { ...request.profile, role: 'response.generate' as const,
    structuredOutput: { enabled: true, schemaId: 'iar.response/v1' } } };
}

/**
 * 为普通及流式成功路径生成确定性的本地响应。
 * @param stream - 是否构造 SSE 数据
 * @returns 不包含真实业务数据的模型响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function modelResponse(stream: boolean): Response {
  return stream ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    : Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
}

/**
 * 在同一链路上执行成功及非成功的普通和流式调用。
 * @param traceId - 要验证的安全业务标识
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function invokeFourCalls(traceId: string): Promise<void> {
  const provider = createTestProvider();
  globalThis.fetch = async (_url, options) => modelResponse(Boolean(JSON.parse(String(options?.body)).stream));
  await provider.complete({ ...createSemanticRequest(), traceId });
  await provider.completeStreamed(streamRequest(traceId), () => {});
  globalThis.fetch = async () => new Response('private-response', { status: 503 });
  await assert.rejects(provider.complete({ ...createSemanticRequest(), traceId }));
  await assert.rejects(provider.completeStreamed(streamRequest(traceId), () => {}));
}

/**
 * 不依赖入口上下文时，UUID 也必须映射后连接业务和传输警告。
 * 网络错误使用敏感哨兵验证原文不会写入日志。
 * 该调用直接使用 provider，不经过 HTTP 服务。
 * 测试夹具替换 fetch 后只生成一次网络异常。
 * 等待异步安全接收器排空后，再读取已捕获的记录。
 * 业务返回错误与输出脱敏分别断言。
 */
test('无 HTTP 上下文时模型告警关联提供的安全 traceId', async () => {
  await withObservabilityFixture(async (fixture) => {
    const traceId = '15bb85f1-191d-4d7b-b2d7-ea6f01324f6a';
    globalThis.fetch = async () => { throw new Error('private-network-error'); };
    await assert.rejects(createTestProvider().complete({ ...createSemanticRequest(), traceId }));
    await flushObservabilityLogs();
    const warning = fixture.records().find((item) => item.event === 'model.http');
    assert.equal(warning?.traceId, safeModelTraceId(traceId));
    assert.notEqual(warning?.traceId, traceId);
    assert.doesNotMatch(fixture.lines.join('\n'), /private-network-error|private-prompt|key-private/);
  });
});

/**
 * 对同一个直接业务链路分别执行普通和流式成功与失败调用。
 * 开启调试只用于验证成功日志，退出时恢复默认级别。
 * 日志必须完整覆盖四次调用，且均使用同一安全 UUID。
 * 成功调用返回本地构造的普通 JSON 或 SSE 响应。
 * 失败调用使用 503 响应，且正文不能进入日志。
 * 结果顺序同时验证调用期间异步上下文没有被替换。
 */
test('直接普通与流式模型成功和失败均关联 UUID', async () => {
  await withObservabilityFixture(async (fixture) => {
    const traceId = '15bb85f1-191d-4d7b-b2d7-ea6f01324f6a';
    const release = registerDebugSignal();
    try {
      process.emit('SIGHUP');
      await invokeFourCalls(traceId);
      await flushObservabilityLogs();
      const records = fixture.records().filter((item) => item.event === 'model.http');
      assert.deepEqual(records.map((item) => item.outcome), ['success', 'success', 'http_error', 'http_error']);
      assert.ok(records.every((item) => item.traceId === safeModelTraceId(traceId) && item.traceId !== traceId));
      assert.doesNotMatch(fixture.lines.join('\n'), /private-response|private-prompt|key-private/);
    } finally { release(); }
  });
});

/**
 * 使用真实网关生成业务审计并比较普通和流式传输日志映射。
 * 非 UUID 含敏感哨兵，必须保留业务审计但不能原文输出。
 * 映射结果须一致，确保不依赖 HTTP 上下文也能关联审计。
 * 网关调用保留原有审计字段，流式 provider 使用相同标识。
 * 映射由进程私有密钥保护，并保持同进程内稳定关联。
 * 响应正文、输入和凭据哨兵均不得出现在结构化记录中。
 */
test('真实网关审计与不可信直接链路的安全映射一致', async () => {
  await withObservabilityFixture(async (fixture) => {
    const traceId = 'private-trace-secret';
    const request = createSemanticRequest();
    const profile = { ...request.profile, profileVersion: '1.0.0', retryPolicy: { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] } };
    const gateway = new ModelGateway({ registry: new ModelProfileRegistry([profile]), providers: { brain: createTestProvider() } });
    globalThis.fetch = async () => new Response('private-response', { status: 503 });
    const result = await gateway.invoke('semantic.extract', { traceId, runId: request.runId, input: { text: 'private-prompt' } },
      (value) => ({ ok: true, value }));
    await assert.rejects(createTestProvider().completeStreamed(streamRequest(traceId), () => {}));
    await flushObservabilityLogs();
    const logs = fixture.records().filter((item) => item.event === 'model.http');
    assert.equal(result.audit[0]?.traceId, traceId);
    assert.equal(logs.length, 2);
    assert.notEqual(logs[0]?.traceId, traceId);
    assert.ok(logs.every((log) => log.traceId === safeModelTraceId(result.audit[0]!.traceId)));
    assert.doesNotMatch(fixture.lines.join('\n'), /private-trace-secret|private-response|private-prompt|key-private/);
  });
});
