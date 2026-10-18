/**
 * 验证直接会话的流式超时、主动取消和兼容链路标识。
 * 测试调用真实会话及 provider，网络使用本地替身。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelProfileRegistry } from '../../../packages/decision/src/model-gateway/index.js';
import { safeModelTraceId } from '../../../examples/agent-sandbox/src/safe-log.js';
import { createStreamRequest, createTestProvider, flushObservabilityLogs, observeAuditTraces, withObservabilityFixture,
  type ObservabilityFixture } from './observability-fixture.js';

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
  const server = await fixture.start({ mode: 'brain', port: 29885 });
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
    const server = await fixture.start({ mode: 'brain', port: 29887 });
    assert.equal((await server.session.turnStreamed('你好', () => {})).status, 'clarification');
    await flushObservabilityLogs();
    const records = fixture.records();
    assert.equal(records.filter((record) => record.event === 'model.http' && record.outcome === 'aborted').length, 1);
    assert.equal(records.some((record) => record.outcome === 'timeout'), false);
    assert.doesNotMatch(fixture.lines.join('\n'), /cancel-private|response-private|key-private/);
  } finally { restore(); }
}

test('真实会话流式调用主动取消仍记录 aborted', () => withObservabilityFixture(checkSessionCancellation));
