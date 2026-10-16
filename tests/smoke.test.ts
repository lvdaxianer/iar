/**
 * 验证 IAR workspace 的 Node.js 测试运行器可以执行编译后的测试。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-16
 */
import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 验证当前 Node.js 进程提供版本信息。
 *
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-16
 */
function assertNodeTestRunnerAvailable(): void {
  assert.equal(process.release.name, 'node');
  assert.match(process.version, /^v\d+\.\d+\.\d+$/);
}

test('workspace test runner executes on Node.js', assertNodeTestRunnerAvailable);
