/** 独立会话的隔离、容量、队列与服务关闭回归。
 * 使用真实服务和 scripted 会话，避免外部模型导致时序不可预测。
 * 并发用 Promise 探针控制业务开始与结束，状态读取仍经过真实路由。
 * 空闲过期测试必须等待超过配置的 TTL，不把该等待用于推断入队。
 * 链路测试捕获安全日志，只比较标识映射与会话 ID 不泄漏。
 * 每个场景关闭服务，避免工作线程和监听端口跨测试保留。
 * 兼容入口使用服务启动时的共享会话，不等于任何独立会话。
 * 独立会话创建使用真实随机标识，测试只检查格式及相互不同。
 * 容量满时拒绝新会话，不允许悄悄驱逐正在运行的会话。
 * 空闲清理与显式删除均需让已删除 ID 的状态读取返回 404。
 * 状态快照同时观察事件、轮次及确认动作，防止只隔离部分字段。
 * 排队测试关注同会话的可见顺序，另一个会话不应被整体阻塞。
 * SSE 连接结束与业务完成并非同一时点，关闭测试分别观察二者。
 * 资源预算耗尽后仍须允许重置，避免有界会话陷入不可恢复状态。
 * 异步安全日志写入使用测试写入器，不输出原始会话标识。
 * 链路追踪检查不记录聊天正文、请求体或完整错误详情。
 * 时间相关断言用于 TTL 或关闭观察，不作为请求已经排队的证明。
 * 真实分段请求体、取消后的容量归还另由请求顺序测试覆盖。
 * 每个状态断言只针对指定会话，不隐含身份认证或租户授权。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { startSandboxServer, type SandboxServerOptions } from '../../../examples/agent-sandbox/src/server.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { resolveSandboxTraceId, setSafeLogWriterForTesting } from '../../../examples/agent-sandbox/src/safe-log.js';

/** 分配独立端口并启动真实服务，供生命周期场景共用。
 * 探针关闭后由服务重新绑定；如端口被抢占，启动错误直接失败。
 * 未指定限制时使用默认预算，指定时只影响当前服务实例。
 * @param sessionLimits - 当前场景需要覆盖的资源上限
 * @returns 可注入请求和关闭的服务句柄
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function startLifecycleServer(sessionLimits?: SandboxServerOptions['sessionLimits']) {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return startSandboxServer({ mode: 'scripted', port: address.port, ...(sessionLimits ? { sessionLimits } : {}) });
}

/** 校验新会话与旧兼容会话均未看到首个会话的历史和待确认动作。
 * 首个会话必须确有事件和待确认动作，避免所有状态为空的假阳性。
 * 第二个会话的错误确认返回冲突，而非引用首个会话的 pending。
 * 不存在的会话通过 404 明确区分，不回退到共享兼容会话。
 * @param server - 当前测试的沙箱服务
 * @param ids - 进行过聊天和未使用的会话标识
 * @returns 无返回值，隔离被破坏时抛出断言错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertIsolatedStates(server: Awaited<ReturnType<typeof startLifecycleServer>>, ids: { id: string; other: string }): Promise<void> {
  const firstState = await server.app.inject({ method: 'GET', url: `/api/sessions/${ids.id}/state` });
  const secondState = await server.app.inject({ method: 'GET', url: `/api/sessions/${ids.other}/state` });
  const legacyState = await server.app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(firstState.json().stats.turnCount, 1);
  assert.equal(firstState.json().stats.pendingConfirmation, true);
  assert.ok(firstState.json().events.length > 0);
  assert.equal(secondState.json().stats.turnCount, 0);
  assert.equal(secondState.json().events.length, 0);
  assert.equal(legacyState.json().stats.turnCount, 0);
  assert.equal(secondState.json().stats.pendingConfirmation, false);
  const confirm = await server.app.inject({ method: 'POST', url: `/api/sessions/${ids.other}/confirm`, payload: { accepted: true, actionId: 'some-action' } });
  assert.equal(confirm.json().reasonCode, 'confirmation_conflict');
  assert.equal((await server.app.inject({ method: 'GET', url: '/api/sessions/not-a-session/state' })).statusCode, 404);
}

/* 连续创建两个独立会话并检查标识格式与唯一性。
 * 只有第一个发起高风险聊天，确保其进入待确认状态。
 * 独立辅助断言随后读取两份状态及旧入口的状态。
 * 第二份状态不得包含首个会话的事件、轮次或 pending。
 * 对另一会话发起确认不得执行首个会话的待确认动作。
 * 旧入口仍存在，但其共享兼容会话不应看到独立会话历史。
 * 此处不将随机标识视为身份认证或租户授权凭据。
 * 关闭服务同时清理本例创建的两个独立会话。
 */
test('独立会话隔离状态与待确认动作，同时保留旧入口', async () => {
  const server = await startLifecycleServer();
  try {
    const first = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const second = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const id = (first.json() as { sessionId: string }).sessionId;
    const other = (second.json() as { sessionId: string }).sessionId;
    assert.match(id, /^[A-Za-z0-9_-]{32,}$/);
    assert.notEqual(id, other);
    const chat = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/chat`, payload: { message: '帮我创建工单' } });
    assert.equal(chat.statusCode, 200);
    assert.equal(chat.json().status, 'awaiting_confirmation');
    await assertIsolatedStates(server, { id, other });
  } finally { await server.close(); }
});

/* 限制容量为一个独立会话，暂停正在执行的对话。
 * entered 标记业务已开始；之后等待超过 50ms 空闲阈值。
 * 活动会话不能被回收，因此创建第二个会话必须返回容量错误。
 * resume 后原聊天成功，状态仍可读取且保留一次轮次。
 * 此处 100ms 等待用于跨越真实 TTL，不作为排队同步手段。
 * finally 解开暂停、恢复全局 turn 方法并关闭服务。
 * 如果测试失败，恢复逻辑仍避免影响后续用例。
 */
test('活动独立会话不会在空闲超时内被回收', async () => {
  const server = await startLifecycleServer({ maxSessions: 1, idleMs: 50 });
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const original = IarSandboxSession.prototype.turn;
  IarSandboxSession.prototype.turn = async function (message) { entered.resolve(); await resume.promise; return original.call(this, message); };
  try {
    const created = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const id = (created.json() as { sessionId: string }).sessionId;
    const chat = server.app.inject({ method: 'POST', url: `/api/sessions/${id}/chat`, payload: { message: '查一下退款政策' } });
    await entered.promise; await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/sessions' })).statusCode, 503);
    resume.resolve(); assert.equal((await chat).statusCode, 200);
    const state = await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` });
    assert.equal(state.statusCode, 200); assert.equal(state.json().stats.turnCount, 1);
  } finally { resume.resolve(); IarSandboxSession.prototype.turn = original; await server.close(); }
});

/** 核对进入队列的业务操作与 HTTP 请求各自绑定的追踪标识。
 * 只选择 chat 开始日志，避免会话创建和其他请求影响比较顺序。
 * 两个业务追踪分别等于对应请求追踪，且彼此不能混为同一值。
 * 全部捕获日志不得包含独立会话 ID，不只检查选出的开始日志。
 * @param records - 采集到的日志、执行追踪及不应出现的会话标识
 * @returns 无返回值，链路或日志边界不满足时抛错
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function assertQueuedTraces(records: { lines: string[]; traces: string[]; id: string }): void {
  const starts = records.lines.map((line) => JSON.parse(line) as { event: string; path?: string; traceId: string })
    .filter((line) => line.event === 'http.request.start' && line.path === '/api/chat');
  assert.equal(starts.length, 2);
  assert.deepEqual(records.traces, starts.map((line) => line.traceId));
  assert.notEqual(records.traces[0], records.traces[1]);
  assert.ok(!records.lines.join('').includes(records.id));
}

/** 记录两个业务请求的执行链路，并暂停首个请求以形成确定的排队。
 * 业务入口调用 resolveSandboxTraceId，观察异步上下文传递结果。
 * 首次进入后才通知测试提交第二个请求，避免请求先后不确定。
 * 第二次不再阻塞；释放首个回调后允许队列按原语义推进。
 * @param context - 服务、同步探针和待记录的链路集合
 * @returns 无返回值；服务关闭时测试无需保留包装器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function pauseTracedTurn(context: { server: Awaited<ReturnType<typeof startLifecycleServer>>; entered: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void>; traces: string[] }): void {
  const turn = context.server.session.turn.bind(context.server.session);
  context.server.session.turn = async (message) => {
    context.traces.push(resolveSandboxTraceId('fallback'));
    if (context.traces.length === 1) { context.entered.resolve(); await context.resume.promise; }
    return turn(message);
  };
}

/* 捕获安全日志后发送两次兼容入口聊天，首个回调由探针阻塞。
 * 创建的独立 sessionId 只用于检查不会出现在日志中。
 * entered 保证第二个请求在首个业务操作开始后提交。
 * setImmediate 给第二个注入请求一次调度机会，不替代业务完成等待。
 * Promise.all 等待两个请求结束，再等待异步日志写入。
 * 按 HTTP 开始日志顺序比较两个执行时 trace，防止异步上下文串线。
 * 最后扫描完整日志，验证会话标识没有通过路径或字段泄漏。
 * finally 解除阻塞、关闭服务并恢复测试日志写入器。
 */
test('排队请求保留各自的追踪标识且日志不含会话标识', async () => {
  const lines: string[] = [];
  const restore = setSafeLogWriterForTesting((buffer, done) => { lines.push(buffer.toString()); done(null, buffer.length); });
  const server = await startLifecycleServer();
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const traces: string[] = [];
  pauseTracedTurn({ server, entered, resume, traces });
  try {
    const created = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const id = (created.json() as { sessionId: string }).sessionId;
    const request = { method: 'POST' as const, url: '/api/chat', payload: { message: '查一下退款政策' } };
    const first = server.app.inject(request); await entered.promise;
    const second = server.app.inject(request);
    await new Promise<void>((resolve) => setImmediate(resolve)); resume.resolve();
    await Promise.all([first, second]);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assertQueuedTraces({ lines, traces, id });
  } finally { resume.resolve(); await server.close(); restore(); }
});

/* 通过真实 fetch 发起 SSE，请求进入会话后立即中止客户端。
 * 服务关闭不能仅因为客户端断开就释放仍在执行的会话资源。
 * dispose 包装器记录释放时点，resume 之前应保持 false。
 * 此处 80ms 是观察关闭尚未完成的等待，并非断线入队同步探针。
 * 恢复业务后等待 close，确认最终释放而不是无限挂起。
 * 请求拒绝被捕获，因为主动 AbortController 取消属于预期结果。
 * finally 解除暂停并关闭服务，防止失败时留有工作线程。
 */
test('流式客户端断开后，服务关闭等待会话中的业务处理结束', async () => {
  const server = await startLifecycleServer();
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  let isDisposed = false; const dispose = server.session.dispose.bind(server.session);
  server.session.dispose = () => { isDisposed = true; dispose(); };
  const turn = server.session.turnStreamed.bind(server.session);
  server.session.turnStreamed = async (text, emit) => { entered.resolve(); await resume.promise; return turn(text, emit); };
  try {
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${server.port}/api/chat?stream=1`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '查一下退款政策' }), signal: controller.signal });
    await entered.promise; controller.abort(); await request.catch(() => undefined);
    const closing = server.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(isDisposed, false);
    resume.resolve(); await closing; assert.equal(isDisposed, true);
  } finally { resume.resolve(); await server.close(); }
});

/** 验证另一会话不受当前阻塞队列影响。
 * 创建独立会话并读取其状态，而非复用被阻塞的兼容会话。
 * 成功响应证明每个会话有独立调度能力，不是全局互斥。
 * @param server - 当前测试的服务
 * @returns 无返回值，创建或状态读取失败时抛错
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertOtherSessionProgress(server: Awaited<ReturnType<typeof startLifecycleServer>>): Promise<void> {
  const created = await server.app.inject({ method: 'POST', url: '/api/sessions' });
  assert.equal(created.statusCode, 201);
  const id = (created.json() as { sessionId: string }).sessionId;
  assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` })).statusCode, 200);
}

/** 验证排队读取和重置在首个对话结束后的状态顺序。
 * 读取应看到聊天已经产生的一轮状态，随后重置返回成功。
 * 调用方再读取最终状态，确认重置确实位于读取之后。
 * @param results - 已发出的两个排队请求
 * @returns 请求全部完成后返回
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertQueuedStateAndReset(results: { state: Promise<{ json(): { stats: { turnCount: number } } }>; reset: Promise<{ statusCode: number }> }): Promise<void> {
  assert.equal((await results.state).json().stats.turnCount, 1);
  assert.equal((await results.reset).statusCode, 200);
}

/* 暂停兼容会话的聊天，再依次提交该会话的读取与重置。
 * 另一独立会话必须能在聊天被阻塞时创建并读取状态。
 * 同会话读取此时不能完成，防止观察到中间状态。
 * 释放聊天后，读取应看到 turnCount=1，随后重置清零。
 * 读取完成标志只用于观察，真正结果仍通过 Promise 等待。
 * 重置后的额外读取确认最终状态，而不只检查重置响应。
 * finally 解除业务阻塞并关闭服务。
 */
test('同会话聊天、读取和重置排队，其他会话独立前进', async () => {
  const server = await startLifecycleServer();
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const original = server.session.turn.bind(server.session);
  server.session.turn = async (message) => { entered.resolve(); await resume.promise; return original(message); };
  try {
    const chat = server.app.inject({ method: 'POST', url: '/api/chat', payload: { message: '查一下退款政策' } });
    await entered.promise;
    let isReadDone = false;
    const state = server.app.inject({ method: 'GET', url: '/api/state' }).then((result) => { isReadDone = true; return result; });
    const reset = server.app.inject({ method: 'POST', url: '/api/reset' });
    await assertOtherSessionProgress(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(isReadDone, false);
    resume.resolve();
    assert.equal((await chat).statusCode, 200);
    await assertQueuedStateAndReset({ state, reset });
    assert.equal((await server.app.inject({ method: 'GET', url: '/api/state' })).json().stats.turnCount, 0);
  } finally { resume.resolve(); await server.close(); }
});

/* maxSessions=1 时第二次创建必须被拒绝，不静默替换第一会话。
 * 等待超过空闲 TTL 后旧 ID 返回 404，容量才可用于新会话。
 * 新会话显式删除后再次读取，应同样得到 404。
 * 该场景验证过期和删除两个释放途径，而非仅验证计数上限。
 * 过期前没有活动请求，区别于上面的活动会话保留场景。
 * 等待时间用于跨过真实 TTL，清理在服务关闭时兜底。
 */
test('会话容量、空闲过期和显式删除受到控制', async () => {
  const server = await startLifecycleServer({ maxSessions: 1, idleMs: 50 });
  try {
    const first = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    assert.equal(first.statusCode, 201);
    const id = (first.json() as { sessionId: string }).sessionId;
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/sessions' })).statusCode, 503);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` })).statusCode, 404);
    const second = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    assert.equal(second.statusCode, 201);
    const other = (second.json() as { sessionId: string }).sessionId;
    assert.equal((await server.app.inject({ method: 'DELETE', url: `/api/sessions/${other}` })).statusCode, 204);
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${other}/state` })).statusCode, 404);
  } finally { await server.close(); }
});

/* 最大待处理额度为 1，流式聊天开始后暂不结束。
 * 同会话的状态读取应返回 503 和稳定 session_busy 原因。
 * entered 确认流式业务已经开始，不用延时推测队列是否占用。
 * 释放流式任务后读取成功并看到一轮状态，证明额度被归还。
 * 与独立会话并发不同，此处读取和聊天都使用旧兼容会话。
 * finally 解除暂停并关闭服务，避免断言失败造成测试挂起。
 */
test('流式处理占用同一会话队列，并对溢出请求安全拒绝', async () => {
  const server = await startLifecycleServer({ maxPending: 1 });
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const original = server.session.turnStreamed.bind(server.session);
  server.session.turnStreamed = async (text, emit) => { entered.resolve(); await resume.promise; return original(text, emit); };
  try {
    const streaming = server.app.inject({ method: 'POST', url: '/api/chat?stream=1', payload: { message: '查一下退款政策' } });
    await entered.promise;
    const rejected = await server.app.inject({ method: 'GET', url: '/api/state' });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json().reasonCode, 'session_busy');
    resume.resolve(); assert.equal((await streaming).statusCode, 200);
    assert.equal((await server.app.inject({ method: 'GET', url: '/api/state' })).json().stats.turnCount, 1);
  } finally { resume.resolve(); await server.close(); }
});

/* 第一轮聊天消耗唯一操作预算，第二轮必须返回 session_limit。
 * 状态预算耗尽不能禁止重置，否则会话无法在有界状态下恢复。
 * 重置成功后再次聊天，验证预算与状态一起恢复可用。
 * 此用例走旧入口；最后一轮产生待确认动作的例外另有专项。
 * finally 关闭服务并释放会话，避免预算状态泄漏到其他用例。
 */
test('有限状态预算耗尽时允许重置并恢复处理', async () => {
  const server = await startLifecycleServer({ maxOperations: 1 });
  try {
    const chat = { method: 'POST' as const, url: '/api/chat', payload: { message: '查一下退款政策' } };
    assert.equal((await server.app.inject(chat)).statusCode, 200);
    const rejected = await server.app.inject(chat);
    assert.equal(rejected.statusCode, 429); assert.equal(rejected.json().reasonCode, 'session_limit');
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/reset' })).statusCode, 200);
    assert.equal((await server.app.inject(chat)).statusCode, 200);
  } finally { await server.close(); }
});
