/**
 * 验证 pnpm 在本地 workspace 中不把私有包替换为 registry 依赖，并且运行脚本不隐式联网安装。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/** 读取根目录中的包管理配置，避免测试依赖当前 shell 的全局配置。 */
function readRootFile(fileName: string): string {
  return readFileSync(resolve(fileName), 'utf8');
}

/** pnpm workspace 必须包含仓库声明的两个 workspace 层级并启用本地链接。 */
test('pnpm workspace 显式链接本地包', () => {
  const config = readRootFile('pnpm-workspace.yaml');
  assert.match(config, /- packages\/\*/);
  assert.match(config, /- packages\/adapters\/\*/);
  assert.match(config, /linkWorkspacePackages:\s*true/);
  assert.match(config, /verifyDepsBeforeRun:\s*false/);
});

/** pnpm run 不应因为 registry 暂时不可用而在脚本前自动安装依赖。 */
test('pnpm run 不隐式安装依赖', () => {
  const workspaceConfig = readRootFile('pnpm-workspace.yaml');
  const npmConfig = readRootFile('.npmrc');
  assert.match(workspaceConfig, /verifyDepsBeforeRun:\s*false/);
  assert.doesNotMatch(npmConfig, /verify-deps-before-run|link-workspace-packages/);
});
