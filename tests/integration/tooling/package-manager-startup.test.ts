/**
 * 验证仓库以 npm 为唯一包管理器：package-lock.json 是唯一锁定来源，
 * 不存在第二个 lockfile，运行脚本不隐式联网安装依赖。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-26
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/** 读取根目录中的包管理配置，避免测试依赖当前 shell 的全局配置。 */
function readRootFile(fileName: string): string {
  return readFileSync(resolve(fileName), 'utf8');
}

/** npm lockfile 必须存在并与 workspace 声明一致。 */
test('npm lockfile 锁定 workspace 依赖', () => {
  assert.ok(existsSync(resolve('package-lock.json')));
  const lock = readRootFile('package-lock.json');
  assert.match(lock, /"packages\/\*"|"packages\/adapters\/\*"/);
});

/** 只允许一个 lockfile：pnpm/yarn/bun 的锁定文件都不应进入仓库。 */
test('不存在第二个 lockfile', () => {
  for (const fileName of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    assert.equal(existsSync(resolve(fileName)), false, `${fileName} 不应存在`);
  }
});

/** npm 运行脚本不应因为 registry 暂时不可用而在脚本前自动安装依赖。 */
test('npm run 不隐式安装依赖', () => {
  const npmConfig = readRootFile('.npmrc');
  assert.doesNotMatch(npmConfig, /verify-deps-before-run/);
});
