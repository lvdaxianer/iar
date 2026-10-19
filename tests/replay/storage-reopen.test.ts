/**
 * 验证 SQLite RegistryStore 在数据库重启后仍保持 Action 幂等。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { type ActionDefinition } from '@iar/contracts';
import { ActionIdempotencyLedger, RegistryActionIdempotencyStore } from '@iar/runtime';
import { SqliteRegistryStore } from '@iar/storage';

/**
 * 创建跨数据库重启测试所需的 Action。
 *
 * @param idempotencyKey - 需要持久化的幂等键
 * @param actionId - Action 标识
 * @returns 合法 Action 定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function action(idempotencyKey: string, actionId: string): ActionDefinition {
  return {
    schemaVersion: 'iar.action/v1',
    actionId,
    runId: 'run-reopen',
    functionId: 'dip.service.stop',
    pluginId: 'dip-api-stop-v1',
    idempotencyKey,
    input: { serviceId: 'test1' },
    riskLevel: 'high',
    confirmationRequired: true
  };
}

test('SQLite idempotency survives closing and reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'iar-storage-'));
  const path = join(directory, 'state.sqlite');
  const firstDatabase = new DatabaseSync(path);
  const firstRegistry = new SqliteRegistryStore(firstDatabase);
  const firstLedger = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(firstRegistry));
  assert.equal((await firstLedger.start(action('reopen-key', 'action-reopen-1'))).ok, true);
  firstDatabase.close();
  const secondDatabase = new DatabaseSync(path);
  const secondRegistry = new SqliteRegistryStore(secondDatabase);
  const secondLedger = new ActionIdempotencyLedger(new RegistryActionIdempotencyStore(secondRegistry));
  assert.equal((await secondLedger.start(action('reopen-key', 'action-reopen-2'))).ok, false);
  secondDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});
