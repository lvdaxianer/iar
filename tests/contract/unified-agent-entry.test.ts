/** 验证统一 Agent 入口负责完整 Plugin 包装配。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIarAgent } from '@iar/agent';

test('unified Agent entry is importable from the package root', () => {
  assert.equal(typeof createIarAgent, 'function');
});

test('unified Agent rejects partial initialization when a Plugin is invalid', () => {
  assert.throws(() => createIarAgent({ plugins: [] }), /plugin|Function|empty|插件/i);
});
