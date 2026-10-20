/**
 * 验证 HTTP 沙箱默认使用内置 SQLite Provider，并支持外部 Provider 注入。
 * 测试不启动独立进程，只通过 Fastify 注入请求检查生命周期边界。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import type { EventEnvelope } from '@iar/contracts';
import type { RecentMessageQuery, SessionIdentity, SessionListPage, SessionListQuery, SessionMessage, SessionPersistenceProvider, SessionSnapshotRecord } from '@iar/persistence-spi';
import { startSandboxServer } from '../../../examples/agent-sandbox/src/server.js';

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

class TestPersistenceProvider implements SessionPersistenceProvider {
  public readonly manifest = { providerId: 'test-provider', apiVersion: 'iar.persistence/v1', capabilities: ['messages', 'events', 'snapshots', 'async'] } as const;
  public readonly identities: SessionIdentity[] = [];
  public openCount = 0;
  public closeCount = 0;

  public async open(): Promise<void> { this.openCount += 1; }
  public async appendMessage(identity: SessionIdentity, _message: SessionMessage): Promise<void> { this.identities.push(structuredClone(identity)); }
  public async appendEvent(identity: SessionIdentity, _event: EventEnvelope): Promise<void> { this.identities.push(structuredClone(identity)); }
  public async saveSnapshot(identity: SessionIdentity, _snapshot: SessionSnapshotRecord): Promise<void> { this.identities.push(structuredClone(identity)); }
  public async loadSnapshot(): Promise<SessionSnapshotRecord | undefined> { return undefined; }
  public async listEvents(): Promise<EventEnvelope[]> { return []; }
  public async listMessages(_sessionId: string, _query?: RecentMessageQuery): Promise<SessionMessage[]> { return []; }
  public async listSessions(_query?: SessionListQuery): Promise<SessionListPage> { return { sessions: [] }; }
  public async flush(): Promise<void> {}
  public async close(): Promise<void> { this.closeCount += 1; }
}

test('服务默认暴露内置 SQLite Provider，并使用文件路径支持重启恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-provider-default-'));
  const snapshotPath = join(directory, 'sessions.sqlite');
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort(), snapshotPath });
  try {
    assert.equal(server.persistenceProvider?.manifest.providerId, 'sqlite');
    const created = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    assert.equal(created.statusCode, 201);
    assert.match(created.json().sessionId, /^[A-Za-z0-9_-]{32}$/);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('服务可注入外部 Provider，并以会话 sessionId 写入后关闭 Provider', async () => {
  const provider = new TestPersistenceProvider();
  const server = await startSandboxServer({ mode: 'scripted', port: await availablePort(), persistenceProvider: provider });
  try {
    const created = await server.app.inject({ method: 'POST', url: '/api/sessions' });
    const sessionId = created.json().sessionId as string;
    const response = await server.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/chat`, payload: { message: '查询服务状态' } });
    assert.equal(response.statusCode, 200);
    await server.session.flushPersistence();
    assert.ok(provider.identities.length > 0);
    assert.ok(provider.identities.every((identity) => identity.sessionId === sessionId));
  } finally {
    await server.close();
  }
  assert.equal(provider.openCount, 1);
  assert.equal(provider.closeCount, 1);
});
