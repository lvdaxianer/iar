import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('Pi host page validates IAR entry envelopes before rendering', () => {
  const page = readFileSync(join(process.cwd(), 'examples/agent-sandbox/src/pi-host/web/index.html'), 'utf8');
  const entryHandler = page.match(/es\.addEventListener\('entry',[\s\S]*?es\.addEventListener\('notify'/)?.[0];

  assert.ok(entryHandler, 'entry SSE handler should exist');
  assert.match(page, /function renderEntry\(entry\)/);
  assert.match(page, /'data' in entry/);
  assert.match(entryHandler, /entry = JSON\.parse\(e\.data\);/);
  assert.match(entryHandler, /entry\.customType !== 'iar-bridge'/);
  assert.match(entryHandler, /catch \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(entryHandler, /!entry\.data/);
  assert.match(entryHandler, /typeof entry\.data !== 'object'/);
  assert.match(entryHandler, /entry\.data/);
  assert.match(entryHandler, /renderEntry\(entry\)/);
});
