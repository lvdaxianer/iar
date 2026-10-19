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
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';

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
