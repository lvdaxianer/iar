/**
 * 验证结构化上下文从多会话、多业务追问、确认、压缩到重启恢复的完整链路。
 * 使用真实 HTTP 入口和临时 SQLite，确保回归覆盖不只停留在单个 adapter。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { buildActionInput } from '../../../examples/agent-sandbox/src/session-helpers.js';

/** 获取可用本地端口，避免端到端测试争抢固定监听端口。 */
async function availablePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/** 发送 JSON 请求并解析沙箱公开响应。 */
async function requestJson<T>(url: string, init: RequestInit): Promise<{ response: Response; body: T }> {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

test('缺少明确 operation 时动作型语义不会默认生成副作用输入', () => {
  assert.deepEqual(buildActionInput('ticket.create', {}, '', 'create'), { missing: ['operation'] });
});

test('自由追问可从结构化事实回答并在压缩重启后继续，同时隔离其他会话', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-e2e-context-'));
  const snapshotPath = join(directory, 'session.sqlite');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  let first: Awaited<ReturnType<typeof startSandboxServer>> | undefined;
  let second: Awaited<ReturnType<typeof startSandboxServer>> | undefined;
  try {
    first = await startSandboxServer({ mode: 'scripted', port, snapshotPath });
    const createdA = await requestJson<{ sessionId: string }>(`${base}/api/sessions`, { method: 'POST' });
    const createdB = await requestJson<{ sessionId: string }>(`${base}/api/sessions`, { method: 'POST' });
    assert.equal(createdA.response.status, 201);
    assert.equal(createdB.response.status, 201);
    const sessionA = createdA.body.sessionId;
    const sessionB = createdB.body.sessionId;

    const pending = await requestJson<{ status: string; pending?: { actionId: string } }>(`${base}/api/sessions/${sessionA}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '帮我创建一个工单' })
    });
    assert.equal(pending.body.status, 'awaiting_confirmation');
    assert.ok(pending.body.pending?.actionId);
    const confirmed = await requestJson<{ status: string }>(`${base}/api/sessions/${sessionA}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, actionId: pending.body.pending!.actionId })
    });
    assert.equal(confirmed.body.status, 'executed');

    const stateA = await requestJson<{ context: { factHistory?: { records: Array<{ values: Record<string, unknown> }> } }; events: unknown[] }>(`${base}/api/sessions/${sessionA}/state`, { method: 'GET' });
    const ticketId = String(stateA.body.context.factHistory?.records.at(-1)?.values.ticketId ?? '');
    assert.match(ticketId, /^ticket-20261018-\d{3}$/);
    const otherBusiness = await requestJson<{ status: string }>(`${base}/api/sessions/${sessionB}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '查询服务状态' })
    });
    assert.equal(otherBusiness.body.status, 'executed');
    const stateB = await requestJson<{ context: { factHistory?: { records: Array<{ values: Record<string, unknown> }> } } }>(`${base}/api/sessions/${sessionB}/state`, { method: 'GET' });
    assert.equal(stateB.body.context.factHistory?.records.some((record) => record.values.ticketId !== undefined), false);

    const freeFollowUp = await requestJson<{ status: string; reply: string }>(`${base}/api/sessions/${sessionA}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '将这个工单单号告诉我下' })
    });
    assert.equal(freeFollowUp.body.status, 'clarification');
    assert.match(freeFollowUp.body.reply, new RegExp(ticketId));

    const compacted = await requestJson<{ ok: boolean; summary?: string }>(`${base}/api/sessions/${sessionA}/compact`, { method: 'POST' });
    assert.equal(compacted.body.ok, true);
    assert.ok(compacted.body.summary);
    await first.close();
    first = undefined;

    second = await startSandboxServer({ mode: 'scripted', port, snapshotPath });
    const resumed = await requestJson<{ resumed: boolean }>(`${base}/api/sessions/${sessionA}/resume`, { method: 'POST' });
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.body.resumed, true);
    const restored = await requestJson<{ context: { summary?: { text: string }; factHistory?: { records: Array<{ values: Record<string, unknown> }> } } }>(`${base}/api/sessions/${sessionA}/state`, { method: 'GET' });
    assert.equal(restored.body.context.summary?.text, compacted.body.summary);
    assert.equal(restored.body.context.factHistory?.records.at(-1)?.values.ticketId, ticketId);
    const restoredFollowUp = await requestJson<{ status: string; reply: string }>(`${base}/api/sessions/${sessionA}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '这个工单编号是多少' })
    });
    assert.equal(restoredFollowUp.body.status, 'clarification');
    assert.match(restoredFollowUp.body.reply, new RegExp(ticketId));

    const newOperation = await requestJson<{ status: string; pending?: { actionId: string } }>(`${base}/api/sessions/${sessionA}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '我想创建一个新工单' })
    });
    assert.equal(newOperation.body.status, 'awaiting_confirmation');
    assert.ok(newOperation.body.pending?.actionId);
    const newConfirmed = await requestJson<{ status: string }>(`${base}/api/sessions/${sessionA}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, actionId: newOperation.body.pending!.actionId })
    });
    assert.equal(newConfirmed.body.status, 'executed');
  } finally {
    await second?.close();
    await first?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('事实型排队追问不会再次触发人工转接副作用', async () => {
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startSandboxServer({ mode: 'scripted', port });
  try {
    const created = await requestJson<{ sessionId: string }>(`${base}/api/sessions`, { method: 'POST' });
    const sessionId = created.body.sessionId;
    const pending = await requestJson<{ status: string; pending?: { actionId: string } }>(`${base}/api/sessions/${sessionId}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '请帮我转人工' })
    });
    assert.equal(pending.body.status, 'awaiting_confirmation');
    assert.ok(pending.body.pending?.actionId);
    const confirmed = await requestJson<{ status: string }>(`${base}/api/sessions/${sessionId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accepted: true, actionId: pending.body.pending!.actionId })
    });
    assert.equal(confirmed.body.status, 'executed');

    const followUp = await requestJson<{ status: string; reply: string; route: { functionId?: string; pluginId?: string; reasonCode: string } }>(`${base}/api/sessions/${sessionId}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '转人工后的排队第几个' })
    });
    assert.equal(followUp.body.status, 'clarification');
    assert.equal(followUp.body.route.functionId, undefined);
    assert.equal(followUp.body.route.pluginId, undefined);
    assert.equal(followUp.body.route.reasonCode, 'plugin_noul');
    assert.match(followUp.body.reply, /queuePosition=3/);
  } finally {
    await server.close();
  }
});
