/**
 * 验证 IAR 包的发布边界、入口文件和 npm tarball 内容。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const localDependencyRoot = join(root, 'node_modules');
const dependencyRoot = existsSync(join(localDependencyRoot, 'ajv')) && existsSync(join(localDependencyRoot, '@sinclair', 'typebox'))
  ? localDependencyRoot
  : resolve(root, '..', '..', '..', '..', 'node_modules');
const packageDirectories = [
  ...readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', entry.name)),
  ...readdirSync(join(root, 'packages', 'adapters'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', 'adapters', entry.name)),
];

const manifests = packageDirectories
  .map((directory) => join(directory, 'package.json'))
  .filter(existsSync)
  .map((file) => ({ file, directory: join(file, '..'), manifest: JSON.parse(readFileSync(file, 'utf8')) }));

assert.equal(manifests.length, 15, 'expected 8 core and 7 adapter packages to have manifests');

function assertTarget(packageDirectory, packageName, field, target) {
  assert.equal(typeof target, 'string', `${packageName} ${field} must be a string`);
  assert.ok(target.startsWith('./'), `${packageName} ${field} must stay inside the package`);
  assert.ok(existsSync(join(packageDirectory, target)), `${packageName} ${field} target is missing: ${target}`);
}

function collectExportTargets(value, field = 'exports') {
  if (typeof value === 'string') return [[field, value]];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => collectExportTargets(child, `${field}.${key}`));
}

for (const { directory, manifest } of manifests) {
  const name = manifest.name;
  assert.equal(manifest.type, 'module', `${name} must use native ESM`);
  assert.equal(manifest.main, './dist/index.js', `${name} main must point to local dist`);
  assert.equal(manifest.types, './dist/index.d.ts', `${name} types must point to local dist`);
  assert.deepEqual(manifest.exports?.['.'], {
    types: './dist/index.d.ts',
    import: './dist/index.js',
  }, `${name} root exports must expose only its compiled public entrypoint`);
  assert.deepEqual(manifest.files, ['dist'], `${name} files must publish only dist`);
  if (name === '@iar/runtime') assert.notEqual(manifest.private, true, '@iar/runtime must be publishable');
  assertTarget(directory, name, 'main', manifest.main);
  assertTarget(directory, name, 'types', manifest.types);

  for (const [field, target] of collectExportTargets(manifest.exports)) {
    assertTarget(directory, name, field, target);
    assert.ok(!target.includes('/src/'), `${name} ${field} must not expose src`);
  }

  const packJson = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const packResult = JSON.parse(packJson)[0];
  const paths = packResult.files.map(({ path }) => path);
  assert.ok(paths.includes('dist/index.js'), `${name} tarball must contain JavaScript`);
  assert.ok(paths.includes('dist/index.d.ts'), `${name} tarball must contain declarations`);
  assert.ok(!paths.some((file) => file.startsWith('src/')), `${name} tarball must not contain src`);
  assert.ok(paths.every((file) => file === 'package.json' || file.startsWith('dist/')), `${name} tarball contains an unexpected file`);

  await import(name);
  try {
    await import(`${name}/src/index.js`);
    assert.fail(`${name}/src/index.js unexpectedly crossed the package boundary`);
  } catch (error) {
    assert.equal(error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `${name} must reject undeclared source imports`);
  }

  const worker = join(directory, 'dist', 'worker.js');
  if (existsSync(worker)) assert.ok(paths.includes('dist/worker.js'), `${name} tarball must contain its worker`);
  console.log(`verified ${name} (${paths.length} packed files)`);
}

for (const publicEntry of ['@iar/plugin', '@iar/runtime']) {
  assert.ok(manifests.some(({ manifest }) => manifest.name === publicEntry), `${publicEntry} must have a publishable package manifest`);
}

const manifestByName = new Map(manifests.map(({ manifest }) => [manifest.name, manifest]));
const runtimeDependencies = Object.keys(manifestByName.get('@iar/runtime')?.dependencies ?? {});
assert.ok(runtimeDependencies.every((name) => !name.startsWith('@iar/adapters-')), '@iar/runtime must not depend on host adapters');
assert.ok(!runtimeDependencies.includes('@iar/pi-bridge'), '@iar/runtime must not depend on Pi');
assert.equal(manifestByName.get('@iar/pi-bridge')?.dependencies, undefined, '@iar/pi-bridge must remain a standalone host adapter');
assert.equal(manifestByName.get('@iar/adapters-postgres')?.dependencies?.['@iar/storage'], '0.1.0', 'PostgreSQL must depend on storage');
assert.equal(manifestByName.get('@iar/adapters-temporal')?.dependencies?.['@iar/runtime'], '0.1.0', 'Temporal must depend on runtime execution contracts');
assert.ok(!manifestByName.has('@iar/agent'), '@iar/agent must not remain a publishable package');
assert.ok(!manifestByName.has('@iar/decision'), '@iar/decision must not remain a publishable package');
assert.ok(!manifestByName.has('@iar/rule-engine'), '@iar/rule-engine must not remain a publishable package');
assert.ok(!manifestByName.has('@iar/workflow'), '@iar/workflow must not remain a publishable package');
assert.ok(!manifestByName.has('@iar/observability'), '@iar/observability must not remain a publishable package');

const representative = manifests.find(({ manifest }) => manifest.name === '@iar/contracts');
assert.ok(representative, 'representative package @iar/contracts must exist');
const consumerDirectory = mkdtempSync(join(tmpdir(), 'iar-package-consumer-'));
try {
  const packJson = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', consumerDirectory], {
    cwd: representative.directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tarball = join(consumerDirectory, JSON.parse(packJson)[0].filename);
  // 仅将已经安装的第三方依赖预置到临时消费者，保证这个本地 tarball 冒烟不依赖网络。
  mkdirSync(join(consumerDirectory, 'node_modules', '@sinclair'), { recursive: true });
  symlinkSync(join(dependencyRoot, '@sinclair', 'typebox'), join(consumerDirectory, 'node_modules', '@sinclair', 'typebox'), 'junction');
  symlinkSync(join(dependencyRoot, 'ajv'), join(consumerDirectory, 'node_modules', 'ajv'), 'junction');
  // npm install --offline 仍会尝试解析 package.json 中的 registry 元数据，
  // 即使依赖已经通过 symlink 预置。直接解包到 node_modules 更准确地模拟
  // “安装后的 tarball”，也使校验器不依赖 npm cache 或网络状态。
  const installedPackageDirectory = join(consumerDirectory, 'node_modules', '@iar', 'contracts');
  mkdirSync(installedPackageDirectory, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', installedPackageDirectory, '--strip-components=1'], {
    stdio: 'ignore',
  });
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('@iar/contracts')"], {
    cwd: consumerDirectory,
    stdio: 'ignore',
  });
  console.log('verified @iar/contracts from a temporary npm tarball consumer');
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}

console.log(`verified ${manifests.length} package distributions`);
