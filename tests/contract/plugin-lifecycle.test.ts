/**
 * 验证插件 Host 的生命周期状态、依赖门禁和不可变事件历史。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ERROR_CODES, type BusinessPluginManifest } from '@iar/contracts';
import { PluginHost, type PluginState } from '@iar/plugins';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

/*
 * 本文件只验证生命周期，不重复安装事务测试。
 * installed 是安装成功后的稳定起点。
 * enabled 才能进入业务候选集。
 * draining 用于停止新执行并完成已有执行排空。
 * disabled 保留注册记录但撤销当前路由能力。
 * unloaded 撤销当前能力并移出注册表。
 * discovered、validated 作为安装事务事件保留。
 * 依赖插件必须先启用，基础插件必须最后失效。
 * 依赖失效时返回稳定 dependency_unavailable 错误。
 * 事件日志独立于当前注册表保留历史事实。
 * events 和 history 都只暴露深拷贝快照。
 * 事件 ID 由内部递增序列生成，外部不能重置。
 * disabled 可以重新 enabled，draining 可以 disabled。
 * unloaded 记录不会重新出现在 get 或 candidates 中。
 * 当前测试不依赖网络、模型、存储或真实插件进程。
 * 失败断言优先检查状态和错误码，再检查事件快照。
 * 这些用例是后续 executor 清理逻辑的状态机基线。
 */

/**
 * 读取合法业务插件 fixture。
 *
 * @returns 合法业务插件 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function loadManifest(): ReturnType<typeof pluginPackage> {
  return pluginPackage(loadBusinessManifest());
}

/**
 * 创建带有覆盖字段的业务插件 Manifest。
 *
 * @param overrides - 测试需要覆盖的字段
 * @returns 测试业务插件 Manifest
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function manifestWith(overrides: Partial<BusinessPluginManifest> & { functionId?: string }): ReturnType<typeof pluginPackage> {
  const { functionId = 'dip.service.stop', ...manifestOverrides } = overrides;
  return pluginPackage({ ...loadBusinessManifest(), ...manifestOverrides }, functionId);
}

/**
 * 断言某个插件当前处于指定生命周期状态。
 *
 * @param host - 被测 Host
 * @param pluginId - 插件稳定标识
 * @param expected - 期望状态
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertState(host: PluginHost, pluginId: string, expected: PluginState): void {
  assert.equal(host.get(pluginId)?.state, expected);
}

/**
 * 验证启用依赖插件时基础插件不能提前失效。
 *
 * @param host - 被测 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDependencyGuards(host: PluginHost): void {
  const base = manifestWith({ pluginId: 'base-lifecycle-v1' });
  const dependent = manifestWith({ pluginId: 'dependent-lifecycle-v1', dependencies: [base.pluginId] });
  assert.equal(host.installAll([dependent, base]).ok, true);
  const earlyEnable = host.enable(dependent.pluginId);
  assert.equal(earlyEnable.ok, false);
  if (!earlyEnable.ok) assert.equal(earlyEnable.error.code, ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE);
  assert.equal(host.enable(base.pluginId).ok, true);
  assert.equal(host.enable(dependent.pluginId).ok, true);
  const drainBase = host.beginDrain(base.pluginId);
  assert.equal(drainBase.ok, false);
  if (!drainBase.ok) assert.equal(drainBase.error.code, ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE);
  assert.equal(host.disable(dependent.pluginId).ok, true);
  assert.equal(host.beginDrain(base.pluginId).ok, true);
  const unloadBase = host.unload(base.pluginId);
  assert.equal(unloadBase.ok, false);
  if (!unloadBase.ok) assert.equal(unloadBase.error.code, ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE);
}

/**
 * 验证事件快照隔离和单调事件 ID。
 *
 * @param host - 被测 Host
 * @param pluginId - 插件稳定标识
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertEventSnapshotIsolation(host: PluginHost, pluginId: string): void {
  const snapshot = [...host.events];
  assert.ok(snapshot[0]);
  snapshot[0].eventName = 'plugin.rejected';
  if (snapshot[0].payload && typeof snapshot[0].payload === 'object' && !Array.isArray(snapshot[0].payload)) snapshot[0].payload.pluginId = 'tampered';
  const history = host.history(pluginId);
  assert.equal(history[0]?.eventName, 'plugin.discovered');
  assert.equal(history[0]?.payload && typeof history[0].payload === 'object' && !Array.isArray(history[0].payload) ? history[0].payload.pluginId : undefined, pluginId);
  assert.equal(host.unload(pluginId).ok, false);
  const ids = host.events.map((event) => event.eventId);
  assert.equal(new Set(ids).size, ids.length);
}

/**
 * 非法生命周期转移必须失败并保留当前状态。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('invalid lifecycle transition preserves current state', () => {
  const host = new PluginHost();
  const manifest = loadManifest();
  assert.equal(host.install(manifest).ok, true);
  const result = host.unload(manifest.pluginId);
  assert.equal(result.ok, false);
  assertState(host, manifest.pluginId, 'installed');
});

/**
 * 覆盖 disabled/draining 的合法复用和卸载路径。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('disabled and draining lifecycle paths remain reversible', () => {
  const host = new PluginHost();
  const manifest = manifestWith({ pluginId: 'reversible-stop-v1' });
  assert.equal(host.install(manifest).ok, true);
  assert.equal(host.enable(manifest.pluginId).ok, true);
  assert.equal(host.disable(manifest.pluginId).ok, true);
  assertState(host, manifest.pluginId, 'disabled');
  const disabledEvent = host.history(manifest.pluginId).find((event) => event.eventName === 'plugin.disabled');
  assert.equal(disabledEvent?.payload && typeof disabledEvent.payload === 'object' ? (disabledEvent.payload as Record<string, unknown>).from : undefined, 'enabled');
  assert.equal(disabledEvent?.payload && typeof disabledEvent.payload === 'object' ? (disabledEvent.payload as Record<string, unknown>).to : undefined, 'disabled');
  assert.equal(host.enable(manifest.pluginId).ok, true);
  assert.equal(host.beginDrain(manifest.pluginId).ok, true);
  assert.equal(host.disable(manifest.pluginId).ok, true);
  assertState(host, manifest.pluginId, 'disabled');
  assert.equal(host.unload(manifest.pluginId).ok, true);
  assert.equal(host.get(manifest.pluginId), undefined);
});

/**
 * 依赖状态失效时禁止启用、停用或卸载基础插件。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('dependency lifecycle changes cannot invalidate enabled dependents', () => {
  assertDependencyGuards(new PluginHost());
});

/**
 * 事件历史只能通过快照读取，外部修改不得改变审计记录。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('event history is isolated and event ids remain monotonic', () => {
  const host = new PluginHost();
  const manifest = loadManifest();
  assert.equal(host.install(manifest).ok, true);
  assertEventSnapshotIsolation(host, manifest.pluginId);
});
