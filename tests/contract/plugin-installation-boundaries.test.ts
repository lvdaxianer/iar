/**
 * 验证插件安装的资源边界、Function 归属审计和批量原子性。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ERROR_CODES, type FunctionPluginManifest } from '../../packages/contracts/src/index.js';
import { MAX_INSTALL_BATCH_SIZE, PluginHost } from '../../packages/plugin-host/src/index.js';

/*
 * 本文件覆盖安装输入的资源和审计边界。
 * 未知 Function 必须保留真实 pluginId。
 * 批量安装超过上限时不应进入契约校验循环。
 * 前项合法、后项非法时必须保持注册表原子性。
 * 这些边界由稳定错误码和拒绝事件共同证明。
 * 测试只使用内存 Host，不依赖网络或外部进程。
 */

/**
 * 读取合法业务插件 fixture。
 *
 * @returns 合法业务插件 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function loadManifest(): FunctionPluginManifest {
  const path = join(process.cwd(), 'tests', 'contract', 'fixtures', 'valid-plugin-manifest.json');
  return JSON.parse(readFileSync(path, 'utf8')) as FunctionPluginManifest;
}

/**
 * 创建带有覆盖字段的业务插件 Manifest。
 *
 * @param overrides - 测试需要覆盖的字段
 * @returns 合法业务插件 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function manifestWith(overrides: Partial<FunctionPluginManifest>): FunctionPluginManifest {
  return { ...loadManifest(), ...overrides };
}

/**
 * 读取拒绝事件的 pluginId。
 *
 * @param host - 被测 Host
 * @param pluginId - 目标插件标识
 * @returns 事件中的插件标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function rejectedPluginId(host: PluginHost, pluginId: string): unknown {
  const event = host.history(pluginId).at(-1);
  const payload = event?.payload;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.pluginId : undefined;
}

/**
 * 未注册的 Function ID 不得进入插件注册表，且拒绝事件必须可审计。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('unknown function ownership preserves rejection attribution', () => {
  const host = new PluginHost({ functionIds: ['dip.service.stop'] });
  const manifest = manifestWith({ pluginId: 'foreign-function-v1', functionId: 'ticket.create' });
  const result = host.install(manifest);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, ERROR_CODES.PLUGIN_FUNCTION_NOT_FOUND);
    assert.equal(result.error.details?.pluginId, manifest.pluginId);
  }
  assert.equal(host.get(manifest.pluginId), undefined);
  assert.equal(rejectedPluginId(host, manifest.pluginId), manifest.pluginId);
});

/**
 * 超限批量必须在校验前拒绝，且不修改现有注册表。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('install batch size is bounded before validation', () => {
  const host = new PluginHost({ functionIds: ['dip.service.stop'] });
  const inputs = Array.from({ length: MAX_INSTALL_BATCH_SIZE + 1 }, (_, index) => manifestWith({ pluginId: `oversized-${index}-v1` }));
  const result = host.installAll(inputs);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, ERROR_CODES.PLUGIN_INSTALL_BATCH_TOO_LARGE);
    assert.equal(result.error.details?.maxBatchSize, MAX_INSTALL_BATCH_SIZE);
  }
  assert.equal(host.get('oversized-0-v1'), undefined);
});

/**
 * 批量输入后项非法时，前项合法插件也不得部分写入。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('mixed batch failure remains atomic', () => {
  const host = new PluginHost({ functionIds: ['dip.service.stop'] });
  const valid = manifestWith({ pluginId: 'valid-before-failure-v1' });
  const invalid = manifestWith({ pluginId: 'invalid-after-valid-v1', functionId: 'ticket.create' });
  const result = host.installAll([valid, invalid]);
  assert.equal(result.ok, false);
  assert.equal(host.get(valid.pluginId), undefined);
  assert.equal(host.get(invalid.pluginId), undefined);
});
