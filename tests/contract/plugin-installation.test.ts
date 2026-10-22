/**
 * 验证插件安装、依赖排序、Function 归属和 SDK Registration 边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ERROR_CODES, type BusinessPluginManifest, type PluginManifest } from '@iar/contracts';
import { normalizePluginToolName, PluginHost } from '@iar/plugins';
import { loadBusinessManifest, pluginPackage } from './fixtures/plugin-package.js';

/*
 * 本文件聚焦安装事务，不重复覆盖生命周期事件细节。
 * 安装失败必须不改变当前注册表。
 * 依赖排序必须不依赖输入顺序或运行时 locale。
 * Function 归属必须在安装和候选解析两个边界校验。
 * system plugin 可以安装，但不能成为业务候选。
 * Handler 只在 Manifest 校验成功后保存。
 * 所有错误都通过稳定错误码断言。
 * 所有快照都来自内存 Host，不依赖外部服务。
 * fixture 与 contracts 包的公开 Schema 保持同步。
 * 本文件作为 Phase 1 安装基线供后续执行器复用。
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
 * 断言基础插件和依赖插件按反向依赖顺序卸载。
 *
 * @param host - 被测 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDependencyLifecycle(host: PluginHost): void {
  assert.equal(host.enable('base-stop-v1').ok, true);
  assert.equal(host.enable('dependent-stop-v1').ok, true);
  assert.equal(host.beginDrain('dependent-stop-v1').ok, true);
  assert.equal(host.unload('dependent-stop-v1').ok, true);
  assert.equal(host.beginDrain('base-stop-v1').ok, true);
  assert.equal(host.unload('base-stop-v1').ok, true);
}

/**
 * 验证独立插件的拓扑结果不受输入顺序影响。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertStableIndependentOrder(): void {
  const first = new PluginHost();
  const second = new PluginHost();
  const alpha = manifestWith({ pluginId: 'alpha-stop-v1' });
  const beta = manifestWith({ pluginId: 'beta-stop-v1' });
  const firstResult = first.installAll([beta, alpha]);
  const secondResult = second.installAll([alpha, beta]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  if (firstResult.ok && secondResult.ok) {
    assert.deepEqual(firstResult.value.map((record) => record.manifest.pluginId), secondResult.value.map((record) => record.manifest.pluginId));
  }
}

/**
 * 验证多层依赖和非 BMP 标识的稳定排序。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertStableComplexOrder(): void {
  const host = new PluginHost();
  const graph = [
    manifestWith({ pluginId: 'graph-gamma-v1', dependencies: ['graph-beta-v1', 'graph-alpha-v1'] }),
    manifestWith({ pluginId: 'graph-beta-v1', dependencies: ['graph-alpha-v1'] }),
    manifestWith({ pluginId: 'graph-alpha-v1' })
  ];
  const graphResult = host.installAll(graph);
  assert.equal(graphResult.ok, true);
  if (graphResult.ok) assert.deepEqual(graphResult.value.map((record) => record.manifest.pluginId), ['graph-alpha-v1', 'graph-beta-v1', 'graph-gamma-v1']);
  const unicodeResult = host.installAll([manifestWith({ pluginId: 'u-\u{10000}-v1' }), manifestWith({ pluginId: 'u-\uE000-v1' })]);
  assert.equal(unicodeResult.ok, true);
  if (unicodeResult.ok) assert.deepEqual(unicodeResult.value.map((record) => record.manifest.pluginId), ['u-\uE000-v1', 'u-\u{10000}-v1']);
}

/**
 * 验证基础插件完整生命周期事件顺序。
 *
 * @param host - 已安装依赖图的 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertLifecycleHistory(host: PluginHost): void {
  assert.deepEqual(host.history('base-stop-v1').map((event) => event.eventName), [
    'plugin.discovered',
    'plugin.validated',
    'plugin.installed',
    'plugin.enabled',
    'plugin.draining',
    'plugin.unloaded'
  ]);
}

/**
 * 验证缺失依赖不会写入注册表。
 *
 * @param host - 被测 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertMissingDependency(host: PluginHost): void {
  const manifest = manifestWith({ pluginId: 'needs-missing-v1', dependencies: ['missing-v1'] });
  const result = host.install(manifest);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ERROR_CODES.PLUGIN_DEPENDENCY_MISSING);
  assert.equal(host.get(manifest.pluginId), undefined);
}

/**
 * 验证依赖环不会写入注册表。
 *
 * @param host - 被测 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDependencyCycle(host: PluginHost): void {
  const left = manifestWith({ pluginId: 'cycle-left-v1', dependencies: ['cycle-right-v1'] });
  const right = manifestWith({ pluginId: 'cycle-right-v1', dependencies: ['cycle-left-v1'] });
  const result = host.installAll([left, right]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ERROR_CODES.PLUGIN_DEPENDENCY_CYCLE);
  assert.equal(host.get(left.pluginId), undefined);
  assert.equal(host.get(right.pluginId), undefined);
}

/**
 * 验证重复安装返回稳定错误码。
 *
 * @param host - 被测 Host
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertDuplicateRegistration(host: PluginHost): void {
  const duplicate = manifestWith({ pluginId: 'duplicate-v1' });
  const duplicateResult = host.installAll([duplicate, duplicate]);
  assert.equal(duplicateResult.ok, false);
  if (!duplicateResult.ok) assert.equal(duplicateResult.error.code, ERROR_CODES.PLUGIN_DUPLICATE_ID);
  assert.equal(host.get(duplicate.pluginId), undefined);
  assert.equal(host.install(manifestWith({ pluginId: 'already-installed-v1' })).ok, true);
  const repeatResult = host.install(manifestWith({ pluginId: 'already-installed-v1' }));
  assert.equal(repeatResult.ok, false);
  if (!repeatResult.ok) assert.equal(repeatResult.error.code, ERROR_CODES.PLUGIN_DUPLICATE_ID);
}

/**
 * 非法安装不得改变当前注册表，但必须留下拒绝事件。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('invalid install is atomic and emits rejection history', () => {
  const host = new PluginHost();
  const invalid = { ...loadManifest(), pluginId: 'broken-install-v1' } as Record<string, unknown>;
  delete invalid.functions;
  const result = host.install(invalid);
  assert.equal(result.ok, false);
  assert.equal(host.get('broken-install-v1'), undefined);
  const rejection = host.events.at(-1);
  assert.equal(rejection?.eventName, 'plugin.rejected');
  if (rejection?.payload && typeof rejection.payload === 'object' && !Array.isArray(rejection.payload)) {
    assert.equal(rejection.payload.pluginId, 'broken-install-v1');
    assert.equal(rejection.payload.reasonCode, ERROR_CODES.CONTRACT_VALIDATION_FAILED);
  }
});

test('custom Function input and output Schema are rejected before registration', () => {
  const invalidInput = pluginPackage(loadBusinessManifest(), 'schema.input.v1', { inputSchema: { type: 'not-a-json-schema-type' } });
  invalidInput.manifest = { ...invalidInput.manifest, pluginId: 'invalid-input-schema-v1' };
  const inputHost = new PluginHost();
  const inputResult = inputHost.install(invalidInput);
  assert.equal(inputResult.ok, false);
  if (!inputResult.ok) assert.equal(inputResult.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
  assert.equal(inputHost.get('invalid-input-schema-v1'), undefined);

  const invalidOutput = pluginPackage(loadBusinessManifest(), 'schema.output.v1', { outputSchema: { type: 'not-a-json-schema-type' } });
  invalidOutput.manifest = { ...invalidOutput.manifest, pluginId: 'invalid-output-schema-v1' };
  const outputHost = new PluginHost();
  const outputResult = outputHost.install(invalidOutput);
  assert.equal(outputResult.ok, false);
  if (!outputResult.ok) assert.equal(outputResult.error.code, ERROR_CODES.INVALID_EMBEDDED_SCHEMA);
  assert.equal(outputHost.get('invalid-output-schema-v1'), undefined);
});

test('PluginHost rejects normalized OpenAI tool name collisions', () => {
  const first = manifestWith({ pluginId: 'api.gateway/order' });
  const second = manifestWith({ pluginId: 'api_u2e_gateway_u2f_order' });
  assert.equal(normalizePluginToolName(first.manifest.pluginId), normalizePluginToolName(second.manifest.pluginId));

  const host = new PluginHost();
  const batchResult = host.installAll([first, second]);
  assert.equal(batchResult.ok, false);
  if (!batchResult.ok) assert.equal(batchResult.error.code, ERROR_CODES.PLUGIN_TOOL_NAME_CONFLICT);
  assert.equal(host.get(first.manifest.pluginId), undefined);
  assert.equal(host.get(second.manifest.pluginId), undefined);

  assert.equal(host.install(first).ok, true);
  const existingResult = host.install(second);
  assert.equal(existingResult.ok, false);
  if (!existingResult.ok) assert.equal(existingResult.error.code, ERROR_CODES.PLUGIN_TOOL_NAME_CONFLICT);
});

/**
 * 依赖安装顺序必须确定，生命周期转移必须可逆。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('dependencies are sorted and lifecycle unload is reversible', () => {
  const host = new PluginHost();
  const base = manifestWith({ pluginId: 'base-stop-v1' });
  const dependent = manifestWith({ pluginId: 'dependent-stop-v1', dependencies: ['base-stop-v1'] });
  const result = host.installAll([dependent, base]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.map((record) => record.manifest.pluginId), ['base-stop-v1', 'dependent-stop-v1']);
  assertDependencyLifecycle(host);
  assert.equal(host.get('base-stop-v1'), undefined);
  assertLifecycleHistory(host);
  assertStableIndependentOrder();
  assertStableComplexOrder();
});

/**
 * system plugin 可以安装但不能进入业务 Function 候选。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('system plugin is excluded from business candidates', () => {
  const host = new PluginHost();
  const { manifest: _manifest, functions: _functions, ...systemBase } = loadManifest();
  const system: PluginManifest = { ...systemBase, pluginId: 'iar.observability.log', pluginKind: 'system', scope: 'runtime', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
  assert.equal(host.install(system).ok, true);
  assert.equal(host.enable(system.pluginId).ok, true);
  assert.deepEqual(host.candidates('dip.service.stop'), []);
});

/**
 * 注册表不应被调用方修改返回值时污染。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('registry records are isolated from returned manifest mutations', () => {
  const host = new PluginHost();
  const manifest = loadManifest();
  const originalInputSchema = structuredClone(manifest.functions[0]!.definition.inputSchema);
  assert.equal(host.install(manifest).ok, true);
  manifest.dependencies.push('mutated-after-install');
  manifest.functions[0]!.definition.inputSchema.type = 'array';
  const returned = host.get(manifest.pluginId);
  assert.ok(returned);
  returned.manifest.dependencies.push('unexpected-dependency');
  assert.deepEqual(host.get(manifest.pluginId)?.manifest.dependencies, []);
  assert.deepEqual(host.get(manifest.pluginId)?.functions.get('dip.service.stop')?.definition.inputSchema, originalInputSchema);
});

/**
 * 缺失依赖、依赖环和重复标识都不得部分写入注册表。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('dependency failures preserve registry atomicity', () => {
  const host = new PluginHost();
  assertMissingDependency(host);
  assertDependencyCycle(host);
  assertDuplicateRegistration(host);
});

/**
 * Function 归属拒绝必须返回稳定错误并留下拒绝事件。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('candidate resolution audits function ownership mismatch', () => {
  const host = new PluginHost();
  const manifest = manifestWith({ pluginId: 'ticket-create-v1', functionId: 'ticket.create' });
  assert.equal(host.install(manifest).ok, true);
  assert.equal(host.enable(manifest.pluginId).ok, true);
  const result = host.resolveCandidate('dip.service.stop', manifest.pluginId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ERROR_CODES.PLUGIN_OWNERSHIP_MISMATCH);
  assert.equal(host.history(manifest.pluginId).at(-1)?.eventName, 'plugin.rejected');
});

/**
 * SDK 注册对象中的 Handler 必须随注册记录保存。
 *
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
test('plugin registration preserves its handler reference', () => {
  const host = new PluginHost();
  const manifest = loadManifest();
  const handler = async () => ({ output: null, status: 'succeeded' as const });
  const result = host.install({ manifest: manifest.manifest, functions: [{ ...manifest.functions[0]!, handler }] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.functions.get('dip.service.stop')?.handler, handler);
  assert.equal(host.get(manifest.pluginId)?.functions.get('dip.service.stop')?.handler, handler);
  const invalidHost = new PluginHost();
  const invalid = invalidHost.install({ manifest: manifest.manifest, functions: [{ ...manifest.functions[0]!, handler: 'not-a-function' as never }] });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, ERROR_CODES.CONTRACT_VALIDATION_FAILED);
});
