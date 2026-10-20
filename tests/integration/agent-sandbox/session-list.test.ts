/** 验证会话列表只暴露有界会话摘要并支持游标分页。 */
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';
import { InMemorySnapshotStore } from '@iar/storage';

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('HTTP session listing returns only summaries and follows the opaque cursor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-session-list-'));
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort(), snapshotPath: join(directory, 'sessions.sqlite') });
  try {
    const first = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const second = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const firstId = first.json().sessionId as string;
    const secondId = second.json().sessionId as string;
    await server.app.inject({ method: 'POST', url: `/api/sessions/${firstId}/chat`, payload: { message: '首条会话摘要一' } });
    await server.app.inject({ method: 'POST', url: `/api/sessions/${secondId}/chat`, payload: { message: '首条会话摘要二' } });
    await server.persistenceProvider?.flush();

    const firstPage = await server.app.inject({ method: 'GET', url: '/api/sessions?limit=1' });
    assert.equal(firstPage.statusCode, 200);
    const firstBody = firstPage.json() as { sessions: Array<Record<string, unknown>>; nextCursor?: string };
    assert.equal(firstBody.sessions.length, 1);
    assert.equal(typeof firstBody.nextCursor, 'string');
    assert.equal('lastMessage' in firstBody.sessions[0]!, false);
    assert.match(String(firstBody.sessions[0]?.summary), /^首条会话摘要/);

    const secondPage = await server.app.inject({ method: 'GET', url: `/api/sessions?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}` });
    assert.equal(secondPage.statusCode, 200);
    const secondBody = secondPage.json() as { sessions: Array<Record<string, unknown>>; nextCursor?: string };
    assert.equal(secondBody.sessions.length, 1);
    assert.notEqual(secondBody.sessions[0]?.sessionId, firstBody.sessions[0]?.sessionId);
    assert.equal(secondBody.nextCursor, undefined);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP session listing rejects invalid pagination without reading unbounded history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-session-list-invalid-'));
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort(), snapshotPath: join(directory, 'sessions.sqlite') });
  try {
    const response = await server.app.inject({ method: 'GET', url: '/api/sessions?limit=0' });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { status: 'failed', reasonCode: 'invalid_session_list_query' });
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP session listing remains compatible without a Persistence Provider', async () => {
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort(), snapshotStore: new InMemorySnapshotStore() });
  try {
    const response = await server.app.inject({ method: 'GET', url: '/api/sessions' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { sessions: [] });
  } finally {
    await server.close();
  }
});
