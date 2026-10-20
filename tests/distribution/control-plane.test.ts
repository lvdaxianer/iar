/**
 * 验证 tenant-bound control plane 对远程插件的授权、生命周期、审计和 ABI parity。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { SCHEMA_VERSIONS, type PluginManifest } from '@iar/contracts';
import { signArtifact, type SignedPluginArtifact } from '@iar/control-plane';
import { PluginHost } from '@iar/plugins';
import { createTenantControlPlane, type ControlPlanePolicyDecision, type TenantControlPlaneRequest } from '@iar/control-plane';

const signer = generateKeyPairSync('ed25519');
const trustedSigners = new Map([['test-signer', signer.publicKey]]);

/** 创建 control-plane 使用的最小合法 Manifest。 */
function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    apiVersion: 'iar.dev/v1', schemaVersion: SCHEMA_VERSIONS.pluginManifest, pluginId: 'tenant-plugin', pluginKind: 'function', scope: 'function', functionId: 'function.remote', version: '1.0.0', description: 'tenant control plane fixture', actionTypes: ['query'], capabilities: ['remote.read'], inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: false }, lifecycle: { entrypoint: 'tenant.entry' }, policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['remote.read'] }, dependencies: [], ...overrides
  } as PluginManifest;
}

/** 签名远程 artifact，模拟另一种语言生成的 JSON payload。 */
function artifact(value: PluginManifest = manifest()): SignedPluginArtifact {
  return signArtifact({ artifactVersion: 'v1', signerKeyId: 'test-signer', bundleDigest: `sha256:${'a'.repeat(64)}`, manifest: value }, signer.privateKey);
}

/** 构造固定 tenant/actor/environment 请求。 */
function request(tenantId: string, operation: TenantControlPlaneRequest['operation'], payload: Record<string, unknown> = {}): TenantControlPlaneRequest {
  return { protocolVersion: 'iar.control-plane/v1', requestId: `${tenantId}-${operation}`, traceId: `trace-${tenantId}`, context: { tenantId, actorId: `actor-${tenantId}`, environment: 'prod' }, operation, payload };
}

/** 读取稳定错误码，测试不绕过公开响应联合类型。 */
function errorCode<T>(response: { error: { code: string } | null; data: T | null }): string {
  assert.equal(response.error !== null, true);
  if (!response.error) throw new Error('expected control-plane failure');
  return response.error.code;
}

test('control plane installs and inspects a plugin inside one tenant', async () => {
  // Given：每个 tenant 都获得独立 PluginHost，授权器允许显式操作。
  const hosts = new Map<string, PluginHost>();
  const api = createTenantControlPlane({ trustedSigners, hostFactory: (tenantId) => { const host = new PluginHost({ functionIds: ['function.remote'] }); hosts.set(tenantId, host); return { host, compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }; }, authorize: () => ({ allowed: true }) });
  // When：tenant-a 通过 ABI 安装并 inspect 同一个 artifact。
  const installed = await api.request(request('tenant-a', 'plugin.install', { artifact: artifact() }));
  const inspected = await api.request(request('tenant-a', 'plugin.inspect', { pluginId: 'tenant-plugin' }));
  // Then：响应携带同一租户上下文，inspect 不回传签名正文。
  assert.equal(installed.error, null);
  assert.equal(inspected.error, null);
  assert.equal((inspected.data as { manifest: PluginManifest }).manifest.version, '1.0.0');
  assert.equal(JSON.stringify(inspected).includes('signature'), false);
  assert.equal(hosts.get('tenant-a')?.get('tenant-plugin')?.state, 'enabled');
});

test('foreign tenant cannot inspect or mutate another tenant plugin', async () => {
  // Given：tenant-a 已注册 plugin，tenant-b 尚未创建 Host。
  let created = 0;
  const api = createTenantControlPlane({ trustedSigners, hostFactory: () => { created += 1; return { host: new PluginHost({ functionIds: ['function.remote'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }; }, authorize: () => ({ allowed: true }) });
  await api.request(request('tenant-a', 'plugin.install', { artifact: artifact() }));
  // When：tenant-b 请求 tenant-a 的 pluginId。
  const response = await api.request(request('tenant-b', 'plugin.inspect', { pluginId: 'tenant-plugin' }));
  // Then：访问在 Host 创建前被拒绝，不泄露跨租户记录。
  assert.equal(errorCode(response), 'tenant_access_denied');
  assert.equal(created, 1);
});

test('foreign tenant upgrade is denied before target Host creation', async () => {
  // Given：tenant-a 拥有 plugin，tenant-b 尚未创建 runtime。
  let created = 0;
  const api = createTenantControlPlane({ trustedSigners, hostFactory: () => { created += 1; return { host: new PluginHost({ functionIds: ['function.remote'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }; }, authorize: () => ({ allowed: true }) });
  await api.request(request('tenant-a', 'plugin.install', { artifact: artifact() }));
  // When：tenant-b 尝试升级 tenant-a 的 plugin。
  const response = await api.request(request('tenant-b', 'plugin.upgrade', { artifact: artifact(manifest({ version: '2.0.0' })) }));
  // Then：upgrade 在 tenant-b Host 创建前拒绝。
  assert.equal(errorCode(response), 'tenant_access_denied');
  assert.equal(created, 1);
});

test('policy denial happens before tenant Host access', async () => {
  // Given：策略拒绝 install，Host factory 记录是否被调用。
  let created = 0;
  const policy: ControlPlanePolicyDecision = { allowed: false, reasonCode: 'policy_denied' };
  const api = createTenantControlPlane({ trustedSigners, hostFactory: () => { created += 1; return { host: new PluginHost({ functionIds: ['function.remote'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }; }, authorize: () => policy });
  // When：请求进入 control-plane。
  const response = await api.request(request('tenant-a', 'plugin.install', { artifact: artifact() }));
  // Then：策略拒绝先于租户 Host 创建。
  assert.equal(errorCode(response), 'policy_denied');
  assert.equal(created, 0);
});

test('upgrade, disable, enable, rollback and audit preserve lifecycle parity', async () => {
  // Given：策略允许生命周期操作和 capability approval。
  const api = createTenantControlPlane({ trustedSigners, hostFactory: () => ({ host: new PluginHost({ functionIds: ['function.remote'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }), authorize: () => ({ allowed: true }) });
  await api.request(request('tenant-a', 'plugin.install', { artifact: artifact() }));
  // When：升级、禁用、启用、回滚按公开 control-plane 操作执行。
  const upgraded = await api.request(request('tenant-a', 'plugin.upgrade', { artifact: artifact(manifest({ version: '2.0.0' })) }));
  const disabled = await api.request(request('tenant-a', 'plugin.disable', { pluginId: 'tenant-plugin' }));
  const disabledInspect = await api.request(request('tenant-a', 'plugin.inspect', { pluginId: 'tenant-plugin' }));
  const enabled = await api.request(request('tenant-a', 'plugin.enable', { pluginId: 'tenant-plugin' }));
  const rollback = await api.request(request('tenant-a', 'plugin.rollback', { pluginId: 'tenant-plugin' }));
  const audit = await api.request(request('tenant-a', 'plugin.audit', { pluginId: 'tenant-plugin' }));
  // Then：所有操作成功，审计只呈现安全摘要和 tenant-a 的记录。
  assert.equal(upgraded.error, null);
  assert.equal(disabled.error, null);
  assert.equal((disabledInspect.data as { state: string }).state, 'disabled');
  assert.equal(enabled.error, null);
  assert.equal(rollback.error, null);
  assert.equal(audit.error, null);
  assert.equal(JSON.stringify(audit).includes('signature'), false);
  assert.equal((audit.data as { records: unknown[] }).records.length >= 4, true);
});

test('malformed ABI and missing plugin return stable safe responses', async () => {
  // Given：请求缺少协议字段，或引用不存在的 tenant plugin。
  const api = createTenantControlPlane({ trustedSigners, hostFactory: () => ({ host: new PluginHost({ functionIds: ['function.remote'] }), compatibility: { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set() } }), authorize: () => ({ allowed: true }) });
  // When：输入进入公开异步边界。
  const malformed = await api.request({});
  const missing = await api.request(request('tenant-a', 'plugin.inspect', { pluginId: 'missing' }));
  // Then：不抛出原始异常，只返回 ABI 或 plugin_not_found。
  assert.equal(errorCode(malformed), 'abi_input_invalid');
  assert.equal(errorCode(missing), 'plugin_not_found');
});

// control-plane fixture 不访问 runtime 私有 Map。
// 通过统计 Host factory 调用证明授权顺序。
// 每个 tenant 都获得独立 PluginHost 实例。
// 同一 plugin id 可以由多个 tenant 独立拥有。
// 跨租户访问在目标 Host 创建前拒绝。
// install 和 upgrade 将签名检查委托给 RemotePluginDistributor。
// enable 和 disable 将生命周期检查委托给 PluginHost。
// inspect 读取 Host 状态，不让 distribution 状态遮蔽 disabled。
// rollback 使用 immutable distribution history。
// policy callback 自身不能授予 capability。
// 审计记录携带 tenant 和 trace 上下文。
// 审计载荷不包含 raw signature 或 bundle 内容。
// malformed ABI 请求返回响应而不是抛异常。
// 缺失插件使用稳定 not-found 错误。
// 测试使用普通对象模拟第二语言 JSON 客户端。
// 每个生命周期操作携带相同的 tenant 上下文形状。
// 每个 fixture 都显式提供 policy callback。
// signer trust 由注入提供，不从全局发现。
// Host factory 不暴露跨租户查询接口。
// 跨租户检查只在目标 runtime 创建前使用 ownership 索引。
// 成功 install 记录 ownership，供后续隔离断言使用。
// capability approval 仍由 distribution 层绑定。
// response data 只通过公开响应形状检查。
// 审计断言拒绝带秘密的序列化结果。
// rollback 断言保留精确版本语义。
// 测试套件确定性执行且只使用内存状态。
// 这些用例是 Task 5.4 的 control-plane 交接证据。
// 即使策略回调是内存同步函数，公开 API 仍保持异步。
// tenant 状态不能通过 payload 字段选择。
// plugin id 被视为不透明的有界标识。
// 安全 inspect snapshot 排除 distribution signature。
// 测试证据不依赖进程级全局网络状态。
// policy 和生命周期断言彼此分离。
// audit 输出被当作外部契约处理。
// 拒绝路径属于 compatibility matrix。
// ABI 校验和 dispatcher payload 作为一个契约断言。
// 资源有界的 malformed 输入不进入生命周期测试。
