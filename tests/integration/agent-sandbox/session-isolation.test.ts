/** 会话资源和确认预算的集成边界。
 * 混合真实 HTTP、响应流事件和子进程，以观察不同资源生命周期。
 * 队列并发测试使用显式探针，避免假设请求一定在某个延时内到达。
 * 旧入口与独立入口均需支持预算用尽后的确认和取消。
 * 格式无效的确认字段与分段请求体竞态分别由相邻测试文件覆盖。
 * 涉及全局原型替换的用例在 finally 中恢复，防止影响同进程测试。
 * 子进程退出用于验证线程未泄漏，不能只依赖构造函数抛错。
 * 预算测试分别覆盖最后一次聊天后的确认和失败重试后的新动作。
 * 兼容接口和独立接口使用不同请求协议，测试不能互相替代。
 * 独立接口确认携带 actionId，旧接口保留原有不绑定行为。
 * 子进程与主测试进程隔离环境变量、工作线程和监听失败影响。
 * 流式 transport 测试手动触发 finish，精确控制响应完成时点。
 * 断线回归通过 socket 关闭及服务侧取消探针观察真实预约状态。
 * 第三次请求在释放队首前成功预约，验证容量立即归还。
 * 确认调用计数验证取消队列节点后业务回调确实没有执行。
 * 错误优先级场景结合不存在的 ID 与两种不同非法消息长度。
 * 成功创建高风险待确认动作需要完整工作流，不直接伪造 pending。
 * 关闭服务是每个场景的最后一步，不在途中破坏正在执行的操作。
 * 这里的限额与超时用于控制会话资源，不代替安全认证。
 * 模型响应大小边界由独立模型传输与可观察性测试覆盖。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';
import { SandboxSessionManager } from '../../../examples/agent-sandbox/src/session-manager.js';
import { streamTurn } from '../../../examples/agent-sandbox/src/http-stream-transport.js';
import { startConfirmationServer } from './isolation-fixture.js';

/** 观察确认请求入队、取消与后续读取入队，无需以延时推测队列状态。
 * 包装真实预约，原有 run 和 cancel 行为保持不变。
 * queuedReady 只在确认操作通过 body 解析并提交后触发。
 * cancelled 只对该确认预约触发，排除其他请求的关闭通知。
 * thirdReady 标记后续读取成功预约，而不等队首释放。
 * 恢复函数还原原型，不能让探针逃逸到其他测试。
 * @returns 三个同步探针和恢复原方法的清理函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function observeQueuedConfirmation() {
  const queuedReady = Promise.withResolvers<void>(); const cancelled = Promise.withResolvers<void>(); const thirdReady = Promise.withResolvers<void>();
  const originalReserve = SandboxSessionManager.prototype.reserve;
  SandboxSessionManager.prototype.reserve = function (...args) {
    const reservation = originalReserve.apply(this, args); let isConfirm = false;
    return {
      run: (operation, action) => {
        if (operation === 'confirm') { isConfirm = true; queuedReady.resolve(); }
        if (operation === 'read') thirdReady.resolve();
        return reservation.run(operation, action);
      },
      cancel: () => { reservation.cancel(); if (isConfirm) cancelled.resolve(); }
    };
  };
  return { queuedReady: queuedReady.promise, cancelled: cancelled.promise, thirdReady: thirdReady.promise,
    restore: () => { SandboxSessionManager.prototype.reserve = originalReserve; } };
}

/** 阻塞队首并统计确认调用；断开的排队请求不应抵达该方法。
 * entered 标记首个业务回调已开始，不只是 HTTP 请求已发送。
 * resume 控制队首结束，允许在其占用期间观察其他预约。
 * 计数只增加于实际确认调用，验证取消不仅改变 HTTP 响应。
 * @param context - 会话、业务暂停探针和调用计数
 * @returns 恢复确认方法的清理函数
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function blockTurnAndCountConfirm(context: { server: Awaited<ReturnType<typeof startConfirmationServer>>; entered: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void>; count: { value: number } }): () => void {
  const original = context.server.session.turn.bind(context.server.session);
  const originalConfirm = context.server.session.confirm.bind(context.server.session);
  context.server.session.turn = async (message) => { context.entered.resolve(); await context.resume.promise; return original(message); };
  context.server.session.confirm = async (accepted) => { context.count.value += 1; return originalConfirm(accepted); };
  return () => { context.server.session.confirm = originalConfirm; };
}

/* maxPending=2：运行中的聊天和排队确认占满两个额度。
 * 客户端真正发送完整 JSON，并等待确认已进入队列后才断开。
 * 队列满时第三个读取被拒绝，证明测试确实到达容量边界。
 * 等待取消探针后重新预约读取，此时队首仍由 resume 阻塞。
 * 读取能入队证明取消立即归还额度，而非等队首完成。
 * 队首释放之后读取成功，确认计数仍为零，排除隐藏副作用。
 * 真实 socket 的 error 被消费，主动 destroy 不造成未处理异常。
 * 超时仅作为死锁保护，不用来猜测请求是否已经预约。
 */
test('排队副作用请求断开立即归还配额且不得执行', { timeout: 5000 }, async () => {
  const server = await startConfirmationServer({ maxPending: 2 });
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const observedQueue = observeQueuedConfirmation();
  const count = { value: 0 }; const restoreConfirm = blockTurnAndCountConfirm({ server, entered, resume, count });
  try {
    const first = fetch(`http://127.0.0.1:${server.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '查一下退款政策' }) });
    await entered.promise;
    const queued = httpRequest({ host: '127.0.0.1', port: server.port, path: '/api/confirm', method: 'POST', headers: { 'content-type': 'application/json' } });
    queued.on('error', () => undefined); queued.end(JSON.stringify({ accepted: true }));
    await observedQueue.queuedReady;
    assert.equal((await server.app.inject({ method: 'GET', url: '/api/state' })).statusCode, 503);
    queued.destroy(); await observedQueue.cancelled;
    const third = server.app.inject({ method: 'GET', url: '/api/state' });
    await observedQueue.thirdReady;
    resume.resolve(); await first;
    assert.equal((await third).statusCode, 200); assert.equal(count.value, 0);
  } finally { resume.resolve(); observedQueue.restore(); restoreConfirm(); await server.close(); }
});

/* 用可控的响应事件模拟流式写入结束，但暂不触发 finish。
 * 会话返回不代表客户端响应已完成，队列仍需等待传输边界。
 * setImmediate 让已完成的会话 Promise 有机会继续执行。
 * 此时检查 completed，验证传输没有仅以业务返回作为完成信号。
 * 先设置 writableFinished 再触发 finish，模拟真实响应的终态。
 * 随后等待 streaming，保证测试不会留下未结算的传输 Promise。
 * 此用例测试传输生命周期，不声称模拟真实的网络断开。
 */
test('流式处理直到响应 finish 才释放会话操作', async () => {
  const raw = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableFinished: false,
    writeHead: () => undefined, write: () => true, end: () => undefined });
  const reply = { raw, hijack: () => undefined } as unknown as Parameters<typeof streamTurn>[2];
  const session = { turnStreamed: async () => undefined } as unknown as IarSandboxSession;
  let completed = false;
  const streaming = streamTurn(session, 'hello', reply).then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const premature = completed; raw.writableFinished = true; raw.emit('finish'); await streaming;
  assert.equal(premature, false);
});

/* 子进程设置非法决策后端，使会话初始化在资源分配阶段失败。
 * 构造异常被捕获后没有其他任务，进程应自行退出。
 * 若工作线程泄漏，spawnSync 超时并使断言失败。
 * 在子进程修改环境变量，避免污染当前测试进程的后续会话。
 * 退出码和超时信息均进入断言，方便区分泄漏与启动错误。
 */
test('配置失败的会话构造不会遗留工作线程', () => {
  const source = "import('./dist/examples/agent-sandbox/src/session.js').then(({IarSandboxSession}) => { process.env.IAR_SANDBOX_DECISION_BACKEND='invalid'; try { new IarSandboxSession({mode:'scripted'}); } catch {} });";
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 1500 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});

/* 一次聊天即用尽 maxOperations=1，但不能困住待确认动作。
 * 两次循环分别覆盖取消与执行，不把一个方向当作另一个的证明。
 * 每次先重置兼容会话，确保用例从相同预算状态开始。
 * 独立会话也重复同一边界，并绑定服务端返回的 actionId。
 * 响应状态和业务终态都要正确，不能只验证没有返回 429。
 * 独立会话每轮重新创建，避免前一次执行影响后一轮确认。
 * finally 关闭服务，释放两种入口各自持有的会话资源。
 */
test('预算最后一轮的待确认动作仍可确认或取消', async () => {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startSandboxServer({ mode: 'scripted', port: address.port, sessionLimits: { maxOperations: 1 } });
  try {
    for (const accepted of [false, true]) {
      await server.app.inject({ method: 'POST', url: '/api/reset' });
      assert.equal((await server.app.inject({ method: 'POST', url: '/api/chat', payload: { message: '帮我创建工单' } })).json().status, 'awaiting_confirmation');
      const result = await server.app.inject({ method: 'POST', url: '/api/confirm', payload: { accepted } });
      assert.equal(result.statusCode, 200);
      assert.equal(result.json().status, accepted ? 'executed' : 'cancelled');
      const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
      const isolated = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/chat`, payload: { message: '帮我创建工单' } });
      const isolatedResult = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, payload: { accepted, actionId: isolated.json().pending.actionId } });
      assert.equal(isolatedResult.statusCode, 200);
      assert.equal(isolatedResult.json().status, accepted ? 'executed' : 'cancelled');
    }
  } finally { await server.close(); }
});

/* 模拟同一 pending 动作连续两次确认失败。
 * 第二轮聊天生成新动作后，仍应保留一次确认机会。
 * 替身只改变确认结果，聊天和预算计算仍经过真实 HTTP 路由。
 * 恢复原方法之后才创建后续动作，避免把替身当作成功执行。
 * 预算为 2，第一和第二轮聊天均可进入待确认状态。
 * finally 无论断言结果都恢复方法并关闭服务。
 */
test('同一待确认动作的失败重试不能耗尽后续动作的确认配额', async () => {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startSandboxServer({ mode: 'scripted', port: address.port, sessionLimits: { maxOperations: 2 } });
  const original = server.session.confirm.bind(server.session);
  try {
    const chat = { method: 'POST' as const, url: '/api/chat', payload: { message: '帮我创建工单' } };
    const confirm = { method: 'POST' as const, url: '/api/confirm', payload: { accepted: true } };
    assert.equal((await server.app.inject(chat)).json().status, 'awaiting_confirmation');
    server.session.confirm = async () => ({ status: 'failed', reply: 'failed', reasonCode: 'failure' });
    await server.app.inject(confirm); await server.app.inject(confirm);
    server.session.confirm = original;
    assert.equal((await server.app.inject(chat)).json().status, 'awaiting_confirmation');
    assert.equal((await server.app.inject(confirm)).statusCode, 200);
  } finally { server.session.confirm = original; await server.close(); }
});

/* 不存在的 sessionId 与非法消息同时出现时，固定返回会话不存在。
 * 空消息和超过输入长度上限的消息分别覆盖两种输入失败。
 * 相同状态码与原因码让客户端不会误以为可以修正输入后重试旧会话。
 * 请求发往独立入口，不改变兼容入口原有的参数校验顺序。
 * 响应检查不依赖 sessionId 的具体编码格式或随机值。
 */
test('不存在会话优先于 chat 输入校验', async () => {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startSandboxServer({ mode: 'scripted', port: address.port });
  try {
    for (const message of ['', 'x'.repeat(4097)]) {
      const response = await server.app.inject({ method: 'POST', url: '/api/sessions/missing/chat', payload: { message } });
      assert.equal(response.statusCode, 404); assert.equal(response.json().reasonCode, 'session_not_found');
    }
  } finally { await server.close(); }
});

/* 无效端口在服务完成部分初始化后导致监听失败。
 * 子进程捕获错误并自然退出，证明已创建的工作线程没有阻止退出。
 * 超时是泄漏检测上界，不是服务启动耗时的性能断言。
 * 将故障放在隔离进程内，防止失败时句柄影响其他集成用例。
 * 父进程同时检查退出码，并在异常时附带子进程诊断。
 */
test('监听失败后释放已创建的会话和工作线程', () => {
  const source = "import('./dist/examples/agent-sandbox/src/server.js').then(async ({startSandboxServer}) => { try { await startSandboxServer({mode:'scripted',port:65536}); } catch {} });";
  const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 1500 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
});

