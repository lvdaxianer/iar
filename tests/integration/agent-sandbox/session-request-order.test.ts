/** 真实分段 HTTP 请求体与会话队列的同步回归。
 * Fastify 注入无法模拟逐段到达，因此这里使用 Node HTTP 客户端。
 * 事件探针观察预约和解析完成，不依靠机器负载敏感的短延时。
 * 三个用例分别覆盖接收顺序、断线和解析失败、慢请求体超时。
 * 服务使用临时端口；测试结束恢复原型包装并关闭服务。
 * 所有状态读取针对同一 sessionId，避免跨会话并发掩盖队列问题。
 * 入队发生在请求头接收时，而不是等待 JSON body 全部到齐。
 * 第一个用例特意暂停 body，验证后到读取不能越过该预约。
 * 第二个用例同时检查客户端中断与服务端 JSON 解析错误。
 * 第三个用例等待服务主动超时，验证慢客户端不能长期阻塞队列。
 * 状态读取在释放预约后完成，观察的是实际路由结果而非内部计数。
 * 请求流的错误监听避免主动断开变成未处理的客户端异常。
 * 不将 HTTP 请求完成时间当成会话业务完成的唯一证明。
 * 每个测试单独构造服务和 ID，不依赖其他用例的资源状态。
 * 同步探针来自测试夹具，恢复时不改写管理器的生产实现。
 * 流式模型取消和响应 finish 由其他传输测试覆盖。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { observeReservations, startConfirmationServer } from './isolation-fixture.js';

/* 首段只包含 JSON 前缀，服务已接收请求头但尚不能解析完整 body。
 * 等待 reserved 后发送状态读取，确保聊天请求确实先取得队列位置。
 * reading 探针表明读取已被接收并提交，不能仅凭发送时间判断。
 * 此时记录读取是否已完成；它不能越过前面的不完整请求体。
 * 补齐聊天体后等待响应结束，再检查读取观察到一次已完成对话。
 * 测试保护 HTTP 接收顺序，而不只保护业务回调开始后的顺序。
 * 响应体主动消费，避免连接因未读取而延长服务关闭时间。
 * finally 恢复探针并关闭服务，即使时序断言失败也释放资源。
 */
test('实际分段请求体按接收顺序阻止后到的状态读取越过', async () => {
  const server = await startConfirmationServer();
  const observedQueue = observeReservations();
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const first = httpRequest({ host: '127.0.0.1', port: server.port, path: `/api/sessions/${id}/chat`, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
    const ended = new Promise<void>((resolve, reject) => { first.on('response', (response) => { response.resume(); response.on('end', resolve); }); first.on('error', reject); });
    first.write('{"message":"');
    await observedQueue.reserved;
    let readDone = false;
    const state = fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/state`).then(async (r) => { readDone = true; return r.json(); });
    await observedQueue.reading;
    const overtook = readDone;
    first.end('查一下退款政策"}');
    await ended; const observed = await state;
    assert.equal(overtook, false); assert.equal(observed.stats.turnCount, 1);
  } finally { observedQueue.restore(); await server.close(); }
});

/* 客户端只写入左花括号，等待预约后主动销毁真实 socket。
 * 等待 cancelled 探针证明服务已处理断线，不使用固定等待时间。
 * 接着提交不完整 JSON，验证解析失败也不会永久占据预约。
 * 后续状态读取必须成功，检查两个不同失败路径后的队列可用性。
 * Promise.race 的一秒计时器只是死锁上界，不判断请求接收顺序。
 * 主动销毁 socket 的 error 被消费，避免预期断线导致进程异常。
 * 会话 ID 在整个场景内不变，读取不能转移到另一条独立队列。
 * finally 总是恢复原型方法并关闭服务。
 */
test('分段请求中断或解析失败释放同会话预约', async () => {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startSandboxServer({ mode: 'scripted', port: address.port });
  const observedQueue = observeReservations();
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const first = httpRequest({ host: '127.0.0.1', port: address.port, path: `/api/sessions/${id}/chat`, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
    first.on('error', () => undefined); first.write('{');
    await observedQueue.reserved;
    first.destroy();
    await observedQueue.cancelled;
    const bad = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/chat`, headers: { 'content-type': 'application/json' }, payload: '{' });
    assert.equal(bad.statusCode, 400);
    const state = await Promise.race([server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reservation not released')), 1000))]);
    assert.equal(state.statusCode, 200);
  } finally { observedQueue.restore(); await server.close(); }
});

/* 保持 JSON 请求体未完成，触发服务端的有界 body 等待时间。
 * 等待 reserved 再提交状态读取，保证后者确实排在慢请求之后。
 * 响应必须是 408 和稳定 request_timeout，而非泄漏解析内部错误。
 * 超时后排队状态读取返回 200，证明预约在失败路径得到释放。
 * 收集完整响应体后再解析原因码，避免把部分 TCP 数据误作 JSON。
 * 测试等待真实超时事件，不用较短 sleep 假定计时器已经触发。
 * 读取不应在超时前抢占队列；顺序的详细断言由首个测试承担。
 * finally 还原队列探针并关闭监听器，避免资源跨测试保留。
 */
test('慢请求体超时返回安全错误并释放预约', async () => {
  const server = await startConfirmationServer();
  const observedQueue = observeReservations();
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const slow = httpRequest({ host: '127.0.0.1', port: server.port, path: `/api/sessions/${id}/chat`, method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
    const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      slow.on('response', (res) => { let body = ''; res.setEncoding('utf8'); res.on('data', (chunk: string) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
      slow.on('error', reject);
    });
    slow.write('{');
    await observedQueue.reserved;
    const state = fetch(`http://127.0.0.1:${server.port}/api/sessions/${id}/state`);
    const timedOut = await response;
    assert.equal(timedOut.status, 408); assert.equal(JSON.parse(timedOut.body).reasonCode, 'request_timeout');
    assert.equal((await state).status, 200);
  } finally { observedQueue.restore(); await server.close(); }
});

