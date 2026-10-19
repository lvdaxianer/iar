import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySnapshotStore } from '@iar/storage';
import { IarSandboxSession } from '../../../examples/agent-sandbox/src/session.js';

test('会话压缩成功后异步快照包含已校验摘要', async () => {
  const snapshotStore = new InMemorySnapshotStore();
  const session = new IarSandboxSession({ mode: 'scripted', sessionId: 'summary-session', snapshotStore });
  try {
    await session.turn('查询服务状态');
    const compacted = await session.compact();
    assert.equal(compacted.ok, true);
    assert.ok(compacted.summary);
    const snapshot = await snapshotStore.get('summary-session');
    assert.equal(snapshot?.context.summary?.text, compacted.summary);
    assert.equal(snapshot?.context.summary?.eventId, compacted.eventId);
  } finally {
    session.dispose();
  }
});
