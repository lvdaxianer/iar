/** 独立确认入口的参数校验、动作绑定和兼容入口回归。
 * 所有请求经过实际服务路由及同会话队列，而非只调用辅助函数。
 * 高风险动作由 scripted 会话创建，避免外部模型网络影响断言。
 * 旧入口保留原有不绑定 actionId 的行为，不应被新契约误伤。
 * 非法输入后的状态读取用于证明拒绝请求没有取消待确认动作。
 * 非布尔 accepted 与非法动作 ID 分开验证，避免一种错误掩盖另一种。
 * 测试覆盖服务端响应码和原因码，也观察当前 pending 是否仍存在。
 * actionId 表示用户看到的动作，不应被当作认证或租户授权令牌。
 * 冲突请求的目标是证明无副作用，而非仅检查响应消息格式。
 * 高风险动作通过真实聊天流程准备，保持工作流及确认状态一致。
 * 重置场景另行验证旧 ID 不会碰巧指向重置后的新动作。
 * 网络并发和客户端断线的先后顺序由队列专项而非本文件验证。
 * 未知会话的错误优先级由会话隔离测试验证。
 * 禁止向旧接口强加独立接口新参数，以免破坏已有调用者。
 * 各测试创建和关闭独立服务，动作与事件不会跨场景共享。
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { startConfirmationServer } from './isolation-fixture.js';

/* accepted 缺失、null、字符串与数字都不能被当成取消操作。
 * 每次 400 后读取 pending，验证请求没有清除用户看到的动作。
 * 无效 accepted 和旧 actionId 同时出现时，稳定返回输入错误。
 * 再次读取 pending，保护校验顺序改变时的无副作用契约。
 * 旧 /api/confirm 使用 null 验证兼容接口仍沿用历史取消行为。
 * 该兼容行为不应解释成独立入口允许非布尔值。
 * finally 关闭服务，避免待确认动作及工作线程影响其他测试。
 */
test('独立确认拒绝非布尔 accepted 且保留待确认动作，兼容入口不变', async () => {
  const server = await startConfirmationServer();
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const pending = (await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/chat`, payload: { message: '帮我创建工单' } })).json().pending;
    for (const value of [undefined, null, 'true', 'false', 0, 1]) {
      const payload = value === undefined ? { actionId: pending.actionId } : { actionId: pending.actionId, accepted: value };
      const response = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, payload });
      assert.equal(response.statusCode, 400); assert.equal(response.json().reasonCode, 'invalid_accepted');
      assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` })).json().pending.actionId, pending.actionId);
    }
    const staleInvalid = await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, payload: { actionId: 'stale', accepted: null } });
    assert.equal(staleInvalid.statusCode, 400); assert.equal(staleInvalid.json().reasonCode, 'invalid_accepted');
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` })).json().pending.actionId, pending.actionId);
    await server.app.inject({ method: 'POST', url: '/api/chat', payload: { message: '帮我创建工单' } });
    const legacy = await server.app.inject({ method: 'POST', url: '/api/confirm', payload: { accepted: null } });
    assert.equal(legacy.json().status, 'cancelled');
  } finally { await server.close(); }
});

/** 校验执行和取消都拒绝过期、缺失或非法动作标识。
 * 同一组输入分别携带 true 和 false，覆盖执行及取消两个方向。
 * 旧 ID 返回冲突；缺失、空白、非字符串和超长值返回参数错误。
 * 调用者随后检查 pending，验证这些失败不会消费当前动作。
 * 该辅助函数通过 HTTP 请求检验队列内的实际校验位置。
 * @param server - 确认接口所在服务
 * @param ids - 会话标识和已过期动作标识
 * @returns 无返回值，接口未拒绝非法输入时抛错
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
async function assertInvalidConfirmIds(server: Awaited<ReturnType<typeof startConfirmationServer>>, ids: { session: string; old: string }): Promise<void> {
  for (const accepted of [true, false]) {
    const stale = await server.app.inject({ method: 'POST', url: `/api/sessions/${ids.session}/confirm`, payload: { accepted, actionId: ids.old } });
    assert.equal(stale.statusCode, 409); assert.equal(stale.json().reasonCode, 'confirmation_conflict');
    const missing = await server.app.inject({ method: 'POST', url: `/api/sessions/${ids.session}/confirm`, payload: { accepted } });
    assert.equal(missing.statusCode, 400);
    for (const actionId of ['', 17, null, ' '.repeat(4), 'x'.repeat(257)]) {
      const invalid = await server.app.inject({ method: 'POST', url: `/api/sessions/${ids.session}/confirm`, payload: { accepted, actionId } });
      assert.equal(invalid.statusCode, 400);
    }
  }
}

/* 两次聊天产生不同 pending，第二个动作替换第一个动作。
 * 拒绝第一个动作的确认和取消，防止旧确认框操作新动作。
 * 缺失及非法 ID 的两种 accepted 值也都必须拒绝。
 * 状态仍指向第二个动作，随后用正确 ID 取消并检查结果。
 * 旧兼容入口没有 actionId，仍允许按其原协议取消动作。
 * 这些断言既保护安全边界，也保护既有客户端可用性。
 * finally 关闭服务，避免待确认状态或线程泄漏。
 */
test('独立会话确认和取消必须匹配当前动作，旧入口仍兼容', async () => {
  const server = await startConfirmationServer();
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const chat = { method: 'POST' as const, url: `/api/sessions/${id}/chat`, payload: { message: '帮我创建工单' } };
    const first = (await server.app.inject(chat)).json().pending.actionId as string;
    const second = (await server.app.inject(chat)).json().pending.actionId as string;
    assert.notEqual(first, second);
    await assertInvalidConfirmIds(server, { session: id, old: first });
    assert.equal((await server.app.inject({ method: 'GET', url: `/api/sessions/${id}/state` })).json().pending.actionId, second);
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, payload: { accepted: false, actionId: second } })).json().status, 'cancelled');
    await server.app.inject({ method: 'POST', url: '/api/chat', payload: { message: '帮我创建工单' } });
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/confirm', payload: { accepted: false } })).json().status, 'cancelled');
  } finally { await server.close(); }
});

/* 先创建动作，再重置并创建新的待确认动作。
 * 新旧 ID 必须不同，避免重置后旧确认请求意外匹配。
 * 使用旧 ID 的执行请求返回冲突，不允许执行新动作。
 * 两轮都发往相同 sessionId，验证是重置边界而非会话隔离。
 * 服务在 finally 关闭，即便 ID 或状态断言失败也释放工作线程。
 */
test('重置后的新动作不得复用旧确认标识', async () => {
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = await startSandboxServer({ mode: 'scripted', port: address.port });
  try {
    const id = (await server.app.inject({ method: 'POST', url: '/api/sessions' })).json().sessionId as string;
    const chat = { method: 'POST' as const, url: `/api/sessions/${id}/chat`, payload: { message: '帮我创建工单' } };
    const old = (await server.app.inject(chat)).json().pending.actionId as string;
    await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/reset` });
    const current = (await server.app.inject(chat)).json().pending.actionId as string;
    assert.notEqual(old, current);
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/sessions/${id}/confirm`, payload: { accepted: true, actionId: old } })).statusCode, 409);
  } finally { await server.close(); }
});

