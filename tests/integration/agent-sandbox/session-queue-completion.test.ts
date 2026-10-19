/** 会话预约完成时序的管理器级回归。
 * 不通过 HTTP，以便区分 Promise 结算、队列推进和服务排空。
 * 最小 session 替身不分配线程，故障仅来自队列生命周期。
 * 更高层的真实断线竞态由 HTTP 集成测试覆盖。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxSessionManager } from '../../../examples/agent-sandbox/src/session-manager.js';
import type { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

/** 使用单个预约额度，使容量释放的可见顺序可直接观察。
 * @returns 使用无资源测试会话的管理器
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function manager(): SandboxSessionManager {
  return new SandboxSessionManager('scripted', { dispose() {} } as IarSandboxSession, { maxPending: 1 });
}

/* 每个 await 后立即申请下一个额度，覆盖成功和拒绝两个终态；
 * 若容量在 Promise 解析之后才释放，紧随其后的请求会误报繁忙。
 * maxPending 为 1，第二次调用没有额外空闲槽位可掩盖泄漏。
 * 第一次和第二次均成功，证明正常完成路径对外已释放预约。
 * 抛错回调验证拒绝结果也遵守同样的释放顺序。
 * 错误后的第三次成功调用同时检查失败未遗留永久占用。
 * finally 总是释放管理器，避免测试异常时工作资源存活。
 */
test('成功或失败的 Promise 对调用方可见前已归还容量', async () => {
  const sessions = manager();
  try {
    assert.equal(await sessions.run(undefined, 'read', async () => 1), 1);
    assert.equal(await sessions.run(undefined, 'read', async () => 2), 2);
    await assert.rejects(sessions.run(undefined, 'read', async () => { throw new Error('failed'); }), /failed/);
    assert.equal(await sessions.run(undefined, 'read', async () => 3), 3);
  } finally { sessions.dispose(); }
});

/* 同一个预约重复取消不能重复归还额度。
 * entered/release 显式控制实际业务边界，检查 drain 不能提前完成。
 * 两次 cancel 之后立即启动任务，确认取消不会留下排队额度。
 * 等 entered 后调用 drain，确保断言针对已经开始而非尚未入队的任务。
 * setImmediate 只让 Promise 微任务有机会运行，不充当入队同步探针。
 * release 允许回调结束，随后验证 drain 已完成且额度仍可再用。
 * finally 重复释放探针保证断言失败时不会留下等待中的 Promise。
 */
test('取消仅一次归还配额且 drain 等待实际执行结束', async () => {
  const sessions = manager();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    const cancelled = sessions.reserve(undefined); cancelled.cancel(); cancelled.cancel();
    const running = sessions.run(undefined, 'read', async () => { entered.resolve(); await release.promise; return 1; });
    await entered.promise; let drained = false;
    const drain = sessions.drain().then(() => { drained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(drained, false);
    release.resolve(); assert.equal(await running, 1); await drain;
    assert.equal(await sessions.run(undefined, 'read', async () => 2), 2);
  } finally { release.resolve(); sessions.dispose(); }
});

/* 队首释放后，尾部必须在调用方观察到首个结果前进入执行。
 * drain 等待尾部 release，不能只等待已经完成的队首。
 * 两个预约先创建，再释放队首，排除后到请求的时序歧义。
 * 尾部进入标记在业务回调中设置，直接观察推进而不是计时推测。
 * 首个 Promise 返回后检查该标记，保护调用方可见的队列推进顺序。
 * 尾部仍阻塞时 drain 不可完成；尾部释放后两者都应正常完成。
 * finally 解开两个探针，即使早期断言失败也能释放管理器。
 */
test('队列在首个结果可见前推进且 drain 等待后续业务', async () => {
  const sessions = new SandboxSessionManager('scripted', { dispose() {} } as IarSandboxSession, { maxPending: 2 });
  const headRelease = Promise.withResolvers<void>(); const tailRelease = Promise.withResolvers<void>();
  const tailEntered = Promise.withResolvers<void>(); let isTailEntered = false;
  try {
    const first = sessions.run(undefined, 'read', async () => { await headRelease.promise; return 1; });
    const second = sessions.run(undefined, 'read', async () => { isTailEntered = true; tailEntered.resolve(); await tailRelease.promise; return 2; });
    const drain = sessions.drain(); headRelease.resolve(); assert.equal(await first, 1);
    assert.equal(isTailEntered, true); await tailEntered.promise;
    let isDrained = false; void drain.then(() => { isDrained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(isDrained, false);
    tailRelease.resolve(); assert.equal(await second, 2); await drain;
  } finally { headRelease.resolve(); tailRelease.resolve(); sessions.dispose(); }
});

/* 删除先移出索引但尚未完成，关闭服务仍须等待其业务回调。
 * 这保护不再可查询的会话资源，避免 drain 漏掉在途操作。
 * entered 只在 removeReserved 之后触发，精确标记索引删除时点。
 * 此时会话虽然无法再次查找，删除回调仍可能持有其资源。
 * 测试在 release 之前调用 drain，检查它不会只依赖索引中的会话。
 * 释放后等待删除和 drain，确保两条 Promise 均能收敛。
 * 清理分支始终释放阻塞探针，避免失败时污染后续测试。
 */
test('删除移出索引后 drain 仍等待已接收的删除操作', async () => {
  const sessions = manager(); const id = sessions.create();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    const deleting = sessions.reserve(id, true).run('delete', async (session) => {
      sessions.removeReserved(id, session); entered.resolve(); await release.promise;
    });
    await entered.promise; let isDrained = false;
    const drain = sessions.drain().then(() => { isDrained = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(isDrained, false);
    release.resolve(); await deleting; await drain;
  } finally { release.resolve(); sessions.dispose(); }
});
