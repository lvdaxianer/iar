/**
 * 验证沙箱会话的结构化投影异步保存到 SQLite，并可在服务重启后显式恢复。
 * 测试只使用 scripted provider 和临时数据库，不访问外部模型或生产文件。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqlitePersistenceProvider } from '@iar/storage';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { ScriptedModelProvider } from '../../../examples/agent-sandbox/src/models/scripted-provider.js';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

/** 使用随机本地端口，避免与其他集成测试共享监听器。 */
async function availablePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer(); server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('服务重启后可通过原会话标识恢复最新结构化快照', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-session-persistence-')); const path = join(directory, 'session.sqlite');
  const port = await availablePort();
  try {
    const first = await startSandboxServer({ mode: 'scripted', port, snapshotPath: path });
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' });
    const sessionId = (await created.json() as { sessionId: string }).sessionId;
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '查询服务状态' }) });
    await first.close();
    const second = await startSandboxServer({ mode: 'scripted', port, snapshotPath: path });
    try {
      const resumed = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, { method: 'POST' });
      assert.equal(resumed.status, 200);
      const state = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/state`);
      const body = await state.json() as { context: { integrity: { lastEventId: string } }; events: unknown[] };
      assert.equal(state.status, 200); assert.ok(body.events.length === 0); assert.notEqual(body.context.integrity.lastEventId, 'initial');
    } finally { await second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('成功动作产生的可信事实会随 SQLite 快照恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-fact-persistence-')); const path = join(directory, 'session.sqlite');
  const port = await availablePort();
  try {
    const first = await startSandboxServer({ mode: 'scripted', port, snapshotPath: path });
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' });
    const sessionId = (await created.json() as { sessionId: string }).sessionId;
    const pendingResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '请帮我创建一个工单' }) });
    const pending = await pendingResponse.json() as { status: string; pending?: { actionId: string } };
    assert.equal(pendingResponse.status, 200); assert.equal(pending.status, 'awaiting_confirmation'); assert.ok(pending.pending?.actionId);
    const waitingState = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/state`);
    const waitingBody = await waitingState.json() as { context: { factHistory?: { records: Array<{ values: Record<string, unknown> }> } } };
    assert.equal(waitingBody.context.factHistory?.records.length, 0);
    const confirmedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true, actionId: pending.pending!.actionId }) });
    const confirmed = await confirmedResponse.json() as { status: string };
    assert.equal(confirmedResponse.status, 200); assert.equal(confirmed.status, 'executed');
    await first.close();

    const second = await startSandboxServer({ mode: 'scripted', port, snapshotPath: path });
    try {
      const resumed = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/resume`, { method: 'POST' });
      assert.equal(resumed.status, 200);
      const state = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/state`);
      const body = await state.json() as { context: { factHistory?: { records: Array<{ values: Record<string, unknown>; sourceEventId: string }> } } };
      const ticket = body.context.factHistory?.records.at(-1);
      assert.equal(state.status, 200); assert.equal(body.context.factHistory?.records.length, 1); assert.match(String(ticket?.values.ticketId ?? ''), /^ticket-20261018-\d{3}$/); assert.match(ticket?.sourceEventId ?? '', /^workflow-event-/);
      const nextPendingResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '请再创建一个工单' }) });
      const nextPending = await nextPendingResponse.json() as { pending?: { actionId: string } };
      assert.equal(nextPendingResponse.status, 200); assert.ok(nextPending.pending?.actionId);
      const nextConfirmedResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true, actionId: nextPending.pending!.actionId }) });
      assert.equal(nextConfirmedResponse.status, 200);
      const nextState = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/state`);
      const nextBody = await nextState.json() as { context: { factHistory?: { records: Array<{ sourceEventId: string; values: Record<string, unknown> }> } } };
      assert.equal(nextBody.context.factHistory?.records.length, 2);
      assert.notEqual(nextBody.context.factHistory?.records.at(-1)?.sourceEventId, ticket?.sourceEventId);
      const previous = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '告诉我这个的上一个工单编号' }) });
      const previousBody = await previous.json() as { reply: string };
      assert.match(previousBody.reply, new RegExp(String(ticket?.values.ticketId)));
    } finally { await second.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('会话重启后下一次模型调用只接收 SQLite 中最新的有界消息窗口', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-message-window-'));
  const filename = join(directory, 'session.sqlite');
  const sessionId = 'message-window-session';
  const recentMessageLimit = 5;
  const provider = new SqlitePersistenceProvider();
  const capturedInputs: unknown[] = [];
  const originalComplete = ScriptedModelProvider.prototype.complete;
  ScriptedModelProvider.prototype.complete = async function captureSemanticInput(request) {
    if (request.profile.role === 'semantic.extract') capturedInputs.push(structuredClone(request.input));
    return originalComplete.call(this, request);
  };

  try {
    await provider.open({ filename });
    const first = new IarSandboxSession({ mode: 'scripted', sessionId, persistenceProvider: provider, persistenceProviderOpened: true });
    await first.whenReady();
    for (const message of ['历史-1', '历史-2', '历史-3', '历史-4']) await first.turn(message);
    await first.flushPersistence();
    const persistedMessages = await provider.listMessages(sessionId);
    first.dispose();

    const restored = new IarSandboxSession({ mode: 'scripted', sessionId, persistenceProvider: provider, persistenceProviderOpened: true });
    try {
      await restored.whenReady();
      await restored.turn('恢复后的新问题');
      const input = capturedInputs.at(-1) as { recentMessages?: Array<{ role: string; text: string }> } | undefined;
      assert.deepEqual(input?.recentMessages, persistedMessages.slice(-recentMessageLimit).map((message) => ({ role: message.role, text: message.content })));
    } finally {
      restored.dispose();
    }
  } finally {
    ScriptedModelProvider.prototype.complete = originalComplete;
    await provider.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
