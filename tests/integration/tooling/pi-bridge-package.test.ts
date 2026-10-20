import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PI_BRIDGE_VERSION, type BridgeDisposition } from '@iar/pi-bridge';

test('Pi bridge exports a versioned disposition contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../../../packages/adapters/pi/package.json', import.meta.url), 'utf8')) as {
    exports?: Record<string, unknown>;
    pi?: { extensions?: string[] };
  };
  const dispositions: BridgeDisposition[] = ['pass_through', 'handled', 'clarification', 'awaiting_confirmation'];
  assert.equal(PI_BRIDGE_VERSION, 'iar.pi-bridge/v1');
  assert.deepEqual(dispositions, ['pass_through', 'handled', 'clarification', 'awaiting_confirmation']);
  assert.ok(packageJson.exports?.['.']);
  assert.deepEqual(packageJson.pi?.extensions, ['./dist/pi-extension.js']);
});
