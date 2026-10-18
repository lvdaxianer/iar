/**
 * 验证沙箱关闭失败时安全清理进程信号和会话资源。
 * 使用真实本地服务和可控关闭故障，不调用外部模型。
 * 测试始终恢复真实资源释放方法，防止影响后续测试。
 * 服务关闭异常不应阻止清理进程级信号监听器。
 * 重复关闭复用原结果，避免重复清理引起引用计数错误。
 * 断言同时覆盖首个异常、会话释放和后续服务注册。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { startSandboxServer, type SandboxServerHandle } from '../../../examples/agent-sandbox/src/server.js';

/**
 * 申请并释放操作系统分配的临时端口。
 * @returns 可用于本地测试的端口
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function availablePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/**
 * 模拟 app.close 失败，检查保留原关闭异常并保留会话。
 * 重复关闭不得释放会话，后续服务仍能注册和释放信号。
 * 清理时恢复真实方法并关闭实际监听器，不留下测试服务。
 * 原始错误对象仅在本地断言，不进入安全日志或异常包装。
 * 会话和服务器方法的替换仅作用于本次测试创建的实例。
 * 初始监听器数量作为基准，避免假设进程没有其他监听器。
 * 使用随机临时端口，降低与其他测试监听器冲突的概率。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('关闭失败保留原错误和会话并释放信号引用', async () => {
  const baseline = process.listenerCount('SIGHUP');
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort() });
  const originalClose = server.app.close.bind(server.app);
  const originalDispose = server.session.dispose.bind(server.session);
  const failure = new Error('close-private');
  let disposeCount = 0;
  Reflect.set(server.app, 'close', async () => { throw failure; });
  server.session.dispose = () => { disposeCount += 1; throw new Error('dispose-private'); };
  try {
    await assert.rejects(server.close(), (error: unknown) => error === failure);
    await assert.rejects(server.close(), (error: unknown) => error === failure);
    assert.equal(disposeCount, 0);
    assert.equal(process.listenerCount('SIGHUP'), baseline);
  } finally { await originalClose(); originalDispose(); }
  const next = await startSandboxServer({ mode: 'scripted', port: await availablePort() });
  assert.equal(process.listenerCount('SIGHUP'), baseline + 1);
  await next.close();
  assert.equal(process.listenerCount('SIGHUP'), baseline);
});

/**
 * HTTP 关闭成功而会话释放失败时，仍需释放信号并保留会话错误。
 * 复用关闭结果防止重复执行失败的 dispose。
 * 两次调用均验证返回相同错误对象，不能掩盖错误或替换契约。
 * 测试结束时调用原会话清理方法，避免模拟故障残留资源。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('会话释放失败仍释放信号且重复关闭不重试', async () => {
  const baseline = process.listenerCount('SIGHUP');
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort() });
  const originalDispose = server.session.dispose.bind(server.session);
  const failure = new Error('dispose-private');
  let calls = 0;
  server.session.dispose = () => { calls += 1; throw failure; };
  try {
    await assert.rejects(server.close(), (error: unknown) => error === failure);
    await assert.rejects(server.close(), (error: unknown) => error === failure);
    assert.equal(calls, 1);
    assert.equal(process.listenerCount('SIGHUP'), baseline);
  } finally { originalDispose(); }
});

/**
 * 首次关闭失败后可重试，重叠调用共享同一次关闭。
 * 会话与信号仅清理一次，重试成功后端口必须真正释放。
 * 故障发生在真实监听器关闭之前，并且最终恢复原方法。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('关闭失败可重试并释放端口，同时并发关闭共享尝试', async () => {
  const baseline = process.listenerCount('SIGHUP');
  const port = await availablePort();
  const server = await startSandboxServer({ mode: 'scripted', port });
  const originalClose = server.app.close.bind(server.app);
  const originalDispose = server.session.dispose.bind(server.session);
  const failure = new Error('close-private');
  let calls = 0; let disposals = 0;
  Reflect.set(server.app, 'close', async () => { calls += 1; if (calls === 1) throw failure; await originalClose(); });
  server.session.dispose = () => { disposals += 1; originalDispose(); };
  try {
    await checkRetry(server, failure);
    assert.equal(calls, 2); assert.equal(disposals, 1);
    assert.equal(process.listenerCount('SIGHUP'), baseline);
    await assertPortReleased(port);
  } finally { await originalClose(); }
});

/**
 * 同时验证失败和重试阶段的并发调用共享同一 Promise。
 * @param server - 测试服务
 * @param failure - 首次关闭的原始错误
 * @returns 重试成功后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkRetry(server: SandboxServerHandle, failure: Error): Promise<void> {
  const first = server.close();
  assert.equal(server.close(), first);
  await assert.rejects(first, (error: unknown) => error === failure);
  const retry = server.close();
  assert.equal(server.close(), retry);
  await retry;
}

/**
 * 以重新绑定验证底层监听端口已释放。
 * @param port - 待检查的端口
 * @returns 成功绑定并关闭后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function assertPortReleased(port: number): Promise<void> {
  const probe = createServer(); probe.listen(port, '127.0.0.1'); await once(probe, 'listening');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}

/**
 * 在真实监听端口检查关闭中或关闭失败后的统一安全拒绝。
 * 普通和流式聊天以及状态入口都不能访问已释放会话。
 * 响应不得包含请求、底层关闭错误或实现内部信息。
 * 所有请求只使用本机端口，测试消息是无真实隐私的哨兵。
 * 每次读取完整响应后断言固定状态及结构。
 * 对慢响应设置有限超时，避免生命周期回归阻塞测试。
 * 不依赖模型服务或网络之外的共享基础设施。
 * @param port - 正在监听的本地服务端口
 * @returns 所有入口拒绝检查完成
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function assertClosingRequests(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  for (const path of ['/api/state', '/api/chat', '/api/chat?stream=1']) {
    // 本地请求逐一检查独立入口，避免并发顺序影响断言。
    const options = path === '/api/state' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'private-prompt' }) };
    const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { status: 'failed', reasonCode: 'sandbox_closing' });
    assert.doesNotMatch(body, /private-prompt|close-private|executor_failed/);
  }
}

/**
 * 真实请求覆盖关闭启动、首次失败与成功重试之间的生命周期窗口。
 * 关闭进行中就拒绝请求，失败后保持拒绝且不会重复释放会话。
 * 并发关闭共享各阶段尝试，最终重试必须释放底层监听端口。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('关闭开始后及失败重试前拒绝真实请求', async () => {
  const port = await availablePort();
  const server = await startSandboxServer({ mode: 'scripted', port });
  const originalClose = server.app.close.bind(server.app);
  const originalDispose = server.session.dispose.bind(server.session);
  const failure = new Error('close-private');
  let release = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0; let disposals = 0;
  Reflect.set(server.app, 'close', async () => { calls += 1; if (calls === 1) { await gate; throw failure; } await originalClose(); });
  server.session.dispose = () => { disposals += 1; originalDispose(); };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200);
    await assertClosingCycle(server, port, { failure, release, getDisposals: () => disposals });
    assert.equal(calls, 2); assert.equal(disposals, 1); await assertPortReleased(port);
  } finally { release(); await originalClose(); }
});

/**
 * 检查进行中和失败后均拒绝入口，并验证两次尝试的并发共享。
 * 首次失败后会话仍保留，入口仍拒绝新业务请求。
 * 第一次关闭故障保留原错误，第二次调用必须正常完成。
 * @param server - 测试服务
 * @param port - 本地服务端口
 * @param options - 关闭故障、释放门闩及清理次数
 * @returns 重试成功后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function assertClosingCycle(server: SandboxServerHandle, port: number, options: { failure: Error; release: () => void; getDisposals: () => number }): Promise<void> {
  const first = server.close(); assert.equal(server.close(), first);
  const rejected = assert.rejects(first, (error: unknown) => error === options.failure);
  await assertClosingRequests(port); assert.equal(options.getDisposals(), 0); options.release();
  await rejected; assert.equal(options.getDisposals(), 0);
  await assertClosingRequests(port);
  const retry = server.close(); assert.equal(server.close(), retry); await retry;
}

/**
 * 启动真实聊天请求并在进入真实会话逻辑前挂起。
 * 原始会话方法将在门闩释放后执行，而非由测试替身伪造成功。
 * @param server - 正在监听的沙箱服务
 * @param port - 本地服务端口
 * @returns 请求、入站信号和恢复门闩
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function startPendingTurn(server: SandboxServerHandle, port: number): { request: Promise<Response>; entered: Promise<void>; resume: () => void } {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const originalTurn = server.session.turn.bind(server.session);
  server.session.turn = async (text) => { entered.resolve(); await resume.promise; return originalTurn(text); };
  const request = fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ message: '查一下退款政策' }), signal: AbortSignal.timeout(3000) });
  return { request, entered: entered.promise, resume: resume.resolve };
}

/**
 * 检查关闭失败后真实在途请求仍可完成原始业务逻辑。
 * 失败后新请求受入口保护，成功重试应释放会话一次并关闭端口。
 * @param server - 正在监听的沙箱服务
 * @param port - 本地服务端口
 * @param options - 关闭错误及会话释放计数
 * @returns 请求完成并重试关闭后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function checkPendingTurn(server: SandboxServerHandle, port: number, options: { failure: Error; getDisposals: () => number }): Promise<void> {
  const pending = startPendingTurn(server, port);
  try {
    await pending.entered;
    await assert.rejects(server.close(), (error: unknown) => error === options.failure);
    await assertClosingRequests(port);
    const retry = server.close(); assert.equal(server.close(), retry);
    let isRetrySettled = false;
    void retry.then(() => { isRetrySettled = true; }, () => { isRetrySettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(isRetrySettled, false); assert.equal(options.getDisposals(), 0);
    pending.resume();
    await assertSuccessfulTurn(await pending.request);
    await retry;
    assert.equal(options.getDisposals(), 1); await assertPortReleased(port);
  } finally { pending.resume(); await Promise.allSettled([pending.request]); }
}

/**
 * 验证真实业务动作成功，不能只检查外层对话状态。
 * @param response - 在途聊天请求的响应
 * @returns 解析并断言动作结果后结束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
async function assertSuccessfulTurn(response: Response): Promise<void> {
  assert.equal(response.status, 200);
  const result = await response.json() as { status: string; actionResult?: { status: string; errorCode?: string } };
  assert.equal(result.status, 'executed');
  assert.equal(result.actionResult?.status, 'succeeded', result.actionResult?.errorCode ?? '缺少动作结果');
}

/**
 * 首次 app.close 失败时保留真实在途请求所需的会话。
 * 请求恢复后调用真实会话而不是测试替身，验证业务确实成功。
 * 后续重试必须完成端口释放，重复关闭不会重复释放会话。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
test('关闭失败后在途真实请求成功并在重试后释放会话', { timeout: 5000 }, async () => {
  const baseline = process.listenerCount('SIGHUP');
  const port = await availablePort();
  const server = await startSandboxServer({ mode: 'scripted', port });
  const originalClose = server.app.close.bind(server.app);
  const originalDispose = server.session.dispose.bind(server.session);
  const failure = new Error('close-private');
  let attempts = 0; let disposals = 0;
  Reflect.set(server.app, 'close', async () => { attempts += 1; if (attempts === 1) throw failure; await originalClose(); });
  server.session.dispose = () => { disposals += 1; originalDispose(); };
  try {
    await checkPendingTurn(server, port, { failure, getDisposals: () => disposals });
    await server.close(); assert.equal(disposals, 1); assert.equal(attempts, 2);
    assert.equal(process.listenerCount('SIGHUP'), baseline);
  } finally { await originalClose(); if (disposals === 0) originalDispose(); }
});
