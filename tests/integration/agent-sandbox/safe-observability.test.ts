/**
 * 验证沙箱请求的安全审计行为。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { logModelSuccess, registerDebugSignal, setSafeLogWriterForTesting, writeSafeLog } from '../../../examples/agent-sandbox/src/safe-log.js';
import { createSemanticRequest, createTestProvider, flushObservabilityLogs, withObservabilityFixture, type ObservabilityFixture } from './observability-fixture.js';

/**
 * 验证请求起止日志的关联、时间字段、路由和脱敏边界。
 * 开始与结束记录必须具有相同的入口标识。
 * 同时校验方法、路径、状态及耗时字段的固定含义。
 * 查询参数、认证头及请求正文均不能出现在日志中。
 * @param fixture - 已捕获的入口日志
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function assertHttpAudit(fixture: ObservabilityFixture): void {
  const records = fixture.records();
  const start = records.find((record) => record.event === 'http.request.start');
  const end = records.find((record) => record.event === 'http.request.end');
  assert.ok(start, '缺少入口审计开始记录');
  assert.ok(end, '缺少入口审计结束记录');
  assert.equal(start.requestId, end.requestId);
  assert.equal(start.traceId, end.traceId);
  assert.equal(typeof start.traceId, 'string');
  assert.equal(typeof start.startTime, 'number');
  assert.equal(start.method, 'POST');
  assert.equal(start.path, '/api/chat');
  assert.equal(typeof end.endTime, 'number');
  assert.equal(typeof end.durationMs, 'number');
  assert.equal(end.status, 200);
  assert.doesNotMatch(fixture.lines.join('\n'), /query-private|header-private|prompt-private/);
}

/**
 * 使用敏感请求参数验证 HTTP 审计。
 * 请求经本地服务注入，不依赖外部网络。
 * 响应完成后等待日志异步队列排空。
 * 随后检查入口和结束记录的关联及敏感数据过滤。
 * @param fixture - 隔离的沙箱测试夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkHttpAudit(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29876 });
  const response = await server.app.inject({ method: 'POST', url: '/api/chat?secret=query-private',
    headers: { authorization: 'Bearer header-private' }, payload: { message: 'prompt-private' } });
  assert.equal(response.statusCode, 200);
  await flushObservabilityLogs();
  assertHttpAudit(fixture);
}

test('HTTP 入口审计关联开始和结束且不泄露请求内容', () => withObservabilityFixture(checkHttpAudit));

/**
 * 验证网络异常只产生受限警告且不包含异常原文。
 * fetch 替身直接抛出含敏感哨兵的异常。
 * 通过 provider 的真实路径触发安全传输日志。
 * 校验警告目标、链路标识和耗时字段。
 * @param fixture - 捕获模型日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkNetworkFailure(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => { throw new Error('private-exception token-private'); };
  await assert.rejects(createTestProvider().complete(createSemanticRequest()));
  await flushObservabilityLogs();
  const warning = fixture.records().find((record) => record.level === 'warn' && record.event === 'model.http');
  assert.ok(warning, '模型调用失败应输出警告');
  assert.equal(warning.target, 'model.chat.completions');
  assert.equal(typeof warning.traceId, 'string');
  assert.equal(typeof warning.durationMs, 'number');
  assert.doesNotMatch(fixture.lines.join('\n'), /private-exception|token-private|private-prompt|key-private/);
}

test('模型网络失败记录安全警告且不记录原始异常', () => withObservabilityFixture(checkNetworkFailure));

/**
 * 验证并发请求的告警与各自入口标识对应。
 * 两个请求在同一个服务中并发执行。
 * 网络替身异步失败，模拟上下文切换。
 * 每个入口必须关联到拥有相同 requestId 和 traceId 的警告。
 * @param fixture - 含并发请求日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkConcurrentAudit(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => { await Promise.resolve(); throw new Error('mock failure'); };
  const server = await fixture.start({ mode: 'brain', port: 29877 });
  await Promise.all(['first', 'second'].map((message) => server.app.inject({ method: 'POST', url: '/api/chat', payload: { message } })));
  await flushObservabilityLogs();
  const records = fixture.records();
  const starts = records.filter((record) => record.event === 'http.request.start');
  const warnings = records.filter((record) => record.event === 'model.http');
  assert.equal(starts.length, 2);
  assert.ok(warnings.length >= 2);
  for (const start of starts) {
    assert.ok(warnings.some((warning) => warning.traceId === start.traceId && warning.requestId === start.requestId));
  }
}

test('并发请求的模型告警继承各自入口链路', () => withObservabilityFixture(checkConcurrentAudit));

/**
 * 验证模型非成功状态的警告和响应正文脱敏。
 * 本地替身返回 503 及包含敏感哨兵的正文。
 * provider 仍按原有契约拒绝该调用。
 * 安全日志只允许输出状态码而不能输出响应内容。
 * @param fixture - 捕获模型日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkHttpFailure(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => new Response('private-response', { status: 503 });
  await assert.rejects(createTestProvider().complete(createSemanticRequest()));
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.level === 'warn' && record.event === 'model.http' && record.status === 503));
  assert.doesNotMatch(fixture.lines.join('\n'), /private-response|private-prompt|key-private/);
}

test('模型 HTTP 错误状态产生安全警告', () => withObservabilityFixture(checkHttpFailure));

/**
 * 验证模型调试默认关闭并可由受控信号开启。
 * 同一个 provider 先后在两种级别下执行成功请求。
 * 首次不产生模型调试日志，发送信号后产生调试日志。
 * 最终检查提示词和密钥不会进入任何输出。
 * @param fixture - 隔离的模型测试夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkDebugSwitch(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  await fixture.start({ mode: 'scripted', port: 29878 });
  const provider = createTestProvider();
  const request = createSemanticRequest();
  await provider.complete(request);
  await flushObservabilityLogs();
  assert.equal(fixture.lines.filter((line) => line.includes('"event":"model.http"')).length, 0);
  process.emit('SIGHUP');
  await provider.complete(request);
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'debug'));
  assert.doesNotMatch(fixture.lines.join('\n'), /private-prompt|key-private/);
}

test('运行中的模型调试可通过进程信号切换且默认关闭', () => withObservabilityFixture(checkDebugSwitch));

/**
 * 验证调试关闭时慢调用仍发出警告。
 * 本地响应替身等待超过慢调用阈值。
 * 检查结果分类为 slow 且级别为 warn。
 * 测试不会调用外部模型服务。
 * @param fixture - 捕获模型日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSlowCall(fixture: ObservabilityFixture): Promise<void> {
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  await createTestProvider().complete(createSemanticRequest());
  await flushObservabilityLogs();
  assert.ok(fixture.records().some((record) => record.event === 'model.http' && record.level === 'warn' && record.outcome === 'slow'));
}

test('模型慢调用在调试关闭时仍输出警告', () => withObservabilityFixture(checkSlowCall));

/**
 * 验证日志接收器故障不会影响 HTTP 结果。
 * 替换进程内写入适配器并通过回调报告错误。
 * HTTP 请求结果仍必须为成功状态。
 * 日志故障不得传播到调用者。
 * @param fixture - 隔离的沙箱测试夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkLogSinkFailure(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29880 });
  const restore = setSafeLogWriterForTesting((_buffer, done) => done(new Error('log sink unavailable'), 0));
  try {
    const response = await server.app.inject({ method: 'GET', url: '/api/state' });
    assert.equal(response.statusCode, 200);
    await flushObservabilityLogs();
  } finally { restore(); }
}

test('日志输出失败不会改变 HTTP 请求结果', () => withObservabilityFixture(checkLogSinkFailure));

/**
 * 验证接收器永不返回时 HTTP 请求仍然完成。
 * 该替身故意不调用完成回调，模拟缓慢接收器。
 * 使用超时哨兵避免回归导致测试无限等待。
 * @param fixture - 隔离的沙箱服务夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkSlowSink(fixture: ObservabilityFixture): Promise<void> {
  const server = await fixture.start({ mode: 'scripted', port: 29889 });
  const restore = setSafeLogWriterForTesting(() => {});
  try {
    const response = await Promise.race([
      server.app.inject({ method: 'GET', url: '/api/state' }),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 300))
    ]);
    assert.notEqual(response, 'blocked');
    // 排除超时哨兵后检查实际 HTTP 响应。
    if (response !== 'blocked') assert.equal(response.statusCode, 200);
  } finally { restore(); }
}

test('日志接收器卡住不会阻塞 HTTP 请求', () => withObservabilityFixture(checkSlowSink));

/**
 * 验证序列化器拒绝自由文本、未知字段和非法数字状态。
 * 含敏感哨兵的未知字段和路径均必须被丢弃。
 * 数字状态必须限制在 HTTP 状态码范围内。
 * 同时确认合法事件字段仍能输出，防止空日志假绿。
 * @param fixture - 捕获序列化输出的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkWhitelist(fixture: ObservabilityFixture): Promise<void> {
  writeSafeLog({ level: 'warn', event: 'model.http', outcome: 'network_error',
    prompt: 'prompt-private', headers: 'header-private', path: '/path-private', status: 'token-private' });
  writeSafeLog({ level: 'warn', event: 'model.http', status: 13800138000 });
  await flushObservabilityLogs();
  assert.doesNotMatch(fixture.lines.join('\n'), /prompt-private|header-private|path-private|token-private|13800138000/);
  assert.match(fixture.lines.join('\n'), /model\.http/);
}

test('日志序列化器拒绝非白名单字段和自由文本值', () => withObservabilityFixture(checkWhitelist));

/**
 * 验证重复释放引用不会破坏后续服务的信号注册。
 * 第一个释放函数调用两次，模拟重复关闭。
 * 再次注册后发送信号并记录调试日志。
 * 最终释放第二个引用，避免污染其他测试。
 * @param fixture - 捕获调试日志的夹具
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkRepeatedRelease(fixture: ObservabilityFixture): Promise<void> {
  const firstRelease = registerDebugSignal();
  firstRelease();
  firstRelease();
  const secondRelease = registerDebugSignal();
  try {
    process.emit('SIGHUP');
    logModelSuccess(Date.now(), 200);
    await flushObservabilityLogs();
    assert.ok(fixture.lines.some((line) => line.includes('"level":"debug"')), '重复释放后调试开关应仍可使用');
  } finally {
    secondRelease();
  }
}

test('重复释放调试开关不会影响后续服务注册', () => withObservabilityFixture(checkRepeatedRelease));
