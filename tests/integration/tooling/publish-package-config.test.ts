import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type Manifest = {
  files?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  pi?: { extensions?: string[] };
};

async function readJson(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as Manifest;
}

test('runtime and Pi bridge expose independent public publish metadata', async () => {
  const runtime = await readJson('../../../../packages/runtime/package.json');
  const piBridge = await readJson('../../../../packages/adapters/pi/package.json');
  const root = await readJson('../../../../package.json');

  assert.deepEqual(runtime.publishConfig, { access: 'public' });
  assert.deepEqual(piBridge.publishConfig, { access: 'public' });
  assert.deepEqual(runtime.files, ['dist']);
  assert.deepEqual(piBridge.files, ['dist']);
  assert.ok(piBridge.exports?.['./pi-extension']);
  assert.deepEqual(piBridge.pi?.extensions, ['./dist/pi-extension.js']);
  assert.equal(root.scripts?.['pack:runtime'], 'npm run build && npm pack --workspace @iar/runtime');
  assert.equal(root.scripts?.['pack:pi'], 'npm run build && npm pack --workspace @iar/pi-bridge');
  assert.equal(root.scripts?.['pack:all'], 'npm run build && npm pack --workspaces');
});
