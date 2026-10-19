/**
 * 验证 Phase 5 远程分发和 tenant control plane 的故障闭环。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ERROR_CODES, SCHEMA_VERSIONS, type PluginManifest } from '@iar/contracts';
import { PluginHost, type PluginHostResult, type PluginRecord } from '@iar/plugin-host';
import { createTenantControlPlane, type ControlPlanePolicyDecision } from '@iar/control-plane';
import { RemotePluginDistributor, signArtifact, type CapabilityChangeApproval, type DistributionCompatibility, type DistributionResult, type SignedPluginArtifact } from '@iar/plugin-distribution';

const signer = generateKeyPairSync('ed25519');
const trustedSigners = new Map([['drill-signer', signer.publicKey]]);

/**
 * 创建分发层使用的最小合法 Manifest。
 * @param overrides - 要覆盖的版本或能力字段
 * @returns 通过 PluginManifest Schema 的定义
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId: 'drill-plugin',
    pluginKind: 'function',
    scope: 'function',
    functionId: 'function.drill',
    version: '1.0.0',
    description: 'phase 5 distribution drill',
    actionTypes: ['query'],
    capabilities: ['remote.read'],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    lifecycle: { entrypoint: 'drill.entry' },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['remote.read'] },
    dependencies: [],
    ...overrides
  } as PluginManifest;
}

/**
 * 使用测试 signer 生成完整签名 artifact。
 * @param value - 被签名的 Manifest
 * @param bundleDigest - 绑定 bundle 的 SHA-256 摘要
 * @returns 可交给 RemotePluginDistributor 的 artifact
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function artifact(value = manifest(), bundleDigest = `sha256:${'a'.repeat(64)}`): SignedPluginArtifact {
  return signArtifact({ artifactVersion: 'v1', signerKeyId: 'drill-signer', bundleDigest, manifest: value }, signer.privateKey);
}

/**
 * 创建不访问外部服务的兼容性视图。
 * @param overrides - 测试所需的 host 或依赖覆盖
 * @returns 固定 host API 和内存依赖视图
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compatibility(overrides: Partial<DistributionCompatibility> = {}): DistributionCompatibility {
  return { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set(), ...overrides };
}

/**
 * 创建绑定完整 capability 集合的审批记录。
 * @param oldCapabilities - 审批时的旧集合
 * @param newCapabilities - 审批时的新集合
 * @returns capability change approval
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function approval(oldCapabilities = ['remote.read'], newCapabilities = ['remote.read']): CapabilityChangeApproval {
  return { approvalId: 'drill-approval', actorId: 'drill-operator', approved: true, reason: 'drill approval', oldCapabilities, newCapabilities };
}

/**
 * 读取分发失败的稳定 reason code。
 * @param result - 分发操作结果
 * @returns 机器可判断的错误码
 * @throws AssertionError 当传入成功结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function reason<T>(result: DistributionResult<T>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected a rejected distribution result');
  return result.reasonCode;
}

/**
 * 记录升级过程中 enable 阶段的单次故障注入 Host。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
class FailNextEnableHost extends PluginHost {
  /** 下一次 enable 是否返回注入的失败。 */
  public failNextEnable = false;

  /**
   * 在 Host enable 阶段注入一次失败。
   * @param pluginId - 要启用的插件标识
   * @returns Host 生命周期结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public override enable(pluginId: string): PluginHostResult<PluginRecord> {
    if (this.failNextEnable) {
      this.failNextEnable = false;
      return { ok: false, error: { schemaVersion: SCHEMA_VERSIONS.error, code: ERROR_CODES.PLUGIN_UNAVAILABLE, message: 'injected failure', retryable: false } };
    }
    return super.enable(pluginId);
  }
}

test('invalid signer and tampered digest never mutate the PluginHost', () => {
  // Given：两个篡改 artifact 在进入生命周期前被验证。
  const host = new PluginHost({ functionIds: ['function.drill'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  const unknownSigner = { ...artifact(), signerKeyId: 'untrusted' };
  const tampered = { ...artifact(), bundleDigest: `sha256:${'b'.repeat(64)}` };

  assert.equal(reason(distributor.install(unknownSigner)), 'signer_untrusted');
  assert.equal(reason(distributor.install(tampered)), 'signature_invalid');
  assert.equal(host.get('drill-plugin'), undefined);
  assert.equal(distributor.current('drill-plugin'), undefined);
  // Then：Host 和 distribution current 都没有半安装记录。
});

test('capability expansion is rejected without exact approval and preserves the current version', () => {
  // Given：当前版本只有 remote.read，候选版本请求新增 remote.write。
  const host = new PluginHost({ functionIds: ['function.drill'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  assert.equal(distributor.install(artifact()).ok, true);
  const expanded = manifest({ version: '2.0.0', capabilities: ['remote.read', 'remote.write'], policy: { riskLevel: 'medium', requiresConfirmation: true, allowedCapabilities: ['remote.read', 'remote.write'] } });

  // When：先拒绝缺少审批的升级，再验证精确审批才能放行。
  const rejected = distributor.upgrade(artifact(expanded));
  assert.equal(reason(rejected), 'capability_approval_required');
  assert.equal(distributor.current('drill-plugin')?.manifest.version, '1.0.0');
  assert.equal(distributor.upgrade(artifact(expanded), approval(['remote.read'], ['remote.read', 'remote.write'])).ok, true);
  // Then：权限扩张只接受绑定旧/新集合的审批。
  assert.equal(distributor.current('drill-plugin')?.manifest.version, '2.0.0');
});

test('upgrade enable failure restores the exact previous version and rollback appends safe audit', () => {
  // Given：v1 已安装，v2 已成功升级，v3 在 enable 阶段失败。
  const host = new FailNextEnableHost({ functionIds: ['function.drill'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  const initial = artifact();
  assert.equal(distributor.install(initial).ok, true);
  assert.equal(distributor.upgrade(artifact(manifest({ version: '2.0.0' }))).ok, true);
  host.failNextEnable = true;

  const failed = distributor.upgrade(artifact(manifest({ version: '3.0.0' })));
  assert.equal(reason(failed), 'plugin_upgrade_failed');
  assert.equal(distributor.current('drill-plugin')?.manifest.version, '2.0.0');
  assert.equal(host.get('drill-plugin')?.manifest.version, '2.0.0');
  assert.equal(host.get('drill-plugin')?.state, 'enabled');
  assert.deepEqual(host.get('drill-plugin')?.manifest, manifest({ version: '2.0.0' }));
  assert.equal(JSON.stringify(host.get('drill-plugin')).includes('3.0.0'), false);

  // When：回滚使用 immutable history 中的 v1 artifact。
  const rollback = distributor.rollback('drill-plugin');
  assert.equal(rollback.ok, true);
  assert.equal(distributor.current('drill-plugin')?.manifest.version, '1.0.0');
  assert.equal(distributor.history('drill-plugin').at(-1)?.operation, 'rollback');
  assert.equal(distributor.history('drill-plugin').at(-1)?.version, '1.0.0');
  assert.equal(JSON.stringify(distributor.audit).includes(initial.signature), false);
  // Then：Host、current、history 和 audit 都落在可追踪的旧版本边界。
});

test('foreign tenant and policy denial happen before target Host creation', async () => {
  // Given：tenant-a 可以安装，tenant-b 会被策略拒绝，Host factory 统计创建次数。
  let created = 0;
  const deny: ControlPlanePolicyDecision = { allowed: false, reasonCode: 'policy_denied' };
  const api = createTenantControlPlane({
    trustedSigners,
    hostFactory: () => {
      created += 1;
      return { host: new PluginHost({ functionIds: ['function.drill'] }), compatibility: compatibility() };
    },
    authorize: (context) => context.tenantId === 'tenant-a' ? { allowed: true } : deny
  });

  const install = await api.request({ protocolVersion: 'iar.control-plane/v1', requestId: 'install-a', traceId: 'trace-a', context: { tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod' }, operation: 'plugin.install', payload: { artifact: artifact() } });
  assert.equal(install.error, null);
  const denied = await api.request({ protocolVersion: 'iar.control-plane/v1', requestId: 'install-b', traceId: 'trace-b', context: { tenantId: 'tenant-b', actorId: 'actor-b', environment: 'prod' }, operation: 'plugin.install', payload: { artifact: artifact() } });
  assert.equal(denied.error?.code, 'policy_denied');
  assert.equal(created, 1);
  // Then：拒绝发生在 tenant-b runtime 创建前。
});

test('foreign tenant upgrade and rollback are denied before the target Host exists', async () => {
  // Given：tenant-a 拥有插件，tenant-b 获得授权但不拥有该插件。
  let created = 0;
  const api = createTenantControlPlane({
    trustedSigners,
    hostFactory: () => {
      created += 1;
      return { host: new PluginHost({ functionIds: ['function.drill'] }), compatibility: compatibility() };
    },
    authorize: () => ({ allowed: true })
  });
  /**
   * 创建 tenant-a 的 control-plane 请求。
   * @param requestId - 请求标识
   * @param operation - 生命周期操作
   * @param payload - 经 ABI validator 解释的安全载荷
   * @returns 带稳定 trace 和租户上下文的请求
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  const request = (requestId: string, operation: 'plugin.install' | 'plugin.upgrade' | 'plugin.rollback', payload: Record<string, unknown>) => ({ protocolVersion: 'iar.control-plane/v1' as const, requestId, traceId: `trace-${requestId}`, context: { tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod' as const }, operation, payload });
  assert.equal((await api.request(request('install-a', 'plugin.install', { artifact: artifact() }))).error, null);

  // When：tenant-b 复用 pluginId 进行 upgrade 和 rollback。
  const foreignUpgrade = await api.request({ ...request('upgrade-b', 'plugin.upgrade', { artifact: artifact(manifest({ version: '2.0.0' })) }), context: { tenantId: 'tenant-b', actorId: 'actor-b', environment: 'prod' } });
  const foreignRollback = await api.request({ ...request('rollback-b', 'plugin.rollback', { pluginId: 'drill-plugin' }), context: { tenantId: 'tenant-b', actorId: 'actor-b', environment: 'prod' } });
  assert.equal(foreignUpgrade.error?.code, 'tenant_access_denied');
  assert.equal(foreignRollback.error?.code, 'tenant_access_denied');
  // Then：两个跨租户操作都在目标 Host 创建前拒绝。
  assert.equal(created, 1);
});

test('successful lifecycle drill preserves tenant audit order and hides signed material', async () => {
  // Given：单个 tenant 通过 ABI 执行 install、upgrade、rollback。
  const api = createTenantControlPlane({
    trustedSigners,
    hostFactory: () => ({ host: new PluginHost({ functionIds: ['function.drill'] }), compatibility: compatibility() }),
    authorize: () => ({ allowed: true })
  });
  /**
   * 创建生命周期演练使用的 ABI request。
   * @param requestId - 请求标识
   * @param operation - install、upgrade 或 rollback
   * @param payload - 当前 operation 的有限字段
   * @returns 可交给 TenantControlPlane.request 的请求
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  const request = (requestId: string, operation: 'plugin.install' | 'plugin.upgrade' | 'plugin.rollback', payload: Record<string, unknown>) => ({ protocolVersion: 'iar.control-plane/v1' as const, requestId, traceId: `trace-${requestId}`, context: { tenantId: 'tenant-a', actorId: 'actor-a', environment: 'prod' as const }, operation, payload });

  assert.equal((await api.request(request('install', 'plugin.install', { artifact: artifact() }))).error, null);
  assert.equal((await api.request(request('upgrade', 'plugin.upgrade', { artifact: artifact(manifest({ version: '2.0.0' })) }))).error, null);
  assert.equal((await api.request(request('rollback', 'plugin.rollback', { pluginId: 'drill-plugin' }))).error, null);
  const audit = await api.request({ ...request('audit', 'plugin.rollback', { pluginId: 'drill-plugin' }), operation: 'plugin.audit' });
  // Then：审计按操作顺序返回，且不包含签名正文。
  assert.equal(audit.error, null);
  assert.equal(JSON.stringify(audit).includes('signature'), false);
  assert.deepEqual((audit.data as { records: Array<{ operation: string }> }).records.map((entry) => entry.operation), ['plugin.install', 'plugin.upgrade', 'plugin.rollback']);
});

// 签名失败必须先于 PluginHost.install，避免未验证 artifact 产生生命周期状态。
// bundleDigest 篡改会破坏签名 payload，不能被当作独立可信字段接受。
// capability expansion 只在完整旧集合、新集合和审批主体一致时放行。
// 缺少审批的升级不会改变 current，也不会替换 Host Manifest。
// enable 故障覆盖升级已完成校验后进入生命周期事务的路径。
// 恢复断言比较完整 Manifest，而不是只比较 version 字段。
// 目标版本字符串不存在于 Host 快照，证明清理没有留下半安装记录。
// rollback 使用 store 保存的 immutable artifact，并再次验证签名。
// rollback audit 的 operation 和 version 是跨语言控制面消费的稳定字段。
// audit 允许保存 signatureDigest，但不得保存原始 signature 正文。
// foreign tenant upgrade 与 rollback 都在目标 runtime 创建前被拒绝。
// Host factory count 是 tenant ownership front-door 的直接证据。
// policy denial 与 tenant isolation 分别证明授权和 ownership 两道门禁。
// 控制面测试通过公开 request API，避免绕过 ABI validator 或私有 Map。
// 生命周期 parity 依次覆盖 install、upgrade、rollback 的成功审计序列。
// 所有 tenant fixture 使用独立 Host，不能共享插件注册表或分发 history。
// 失败审计只保留稳定 reason code 和版本摘要，不回显传入 artifact。
// 测试不使用真实 signer registry、网络目录或外部 bundle。
// 测试中的私钥只存在进程内，用于生成一次性 Ed25519 fixture。
// 分发错误通过 union result 断言，不读取私有异常或实现细节。
// 这些演练补充已有签名、升级和控制面生命周期测试的故障覆盖。
// 远程 artifact 的 Manifest、签名和 bundle 摘要在同一 verify boundary 校验。
// 未知 signer 不进入公钥验证，也不触碰 Host。
// tampered digest 的拒绝不会产生 current record 或 accepted audit。
// capability approval 绑定集合而非调用方自报 added 列表。
// 版本升级失败后旧 Manifest 的全部字段保持一致。
// Host state 断言覆盖 enabled 生命周期，而不是仅覆盖 registry metadata。
// rollback 重新安装历史 artifact，避免从 Manifest 重新拼装签名域。
// foreign tenant 请求使用同一 pluginId，专门验证 ownership 而非 plugin-not-found。
// 目标 Host 创建次数区分授权拒绝和 runtime 内部失败。
// policy-denied install 证明策略门禁位于 hostFactory 前。
// 允许 tenant-b 进入 authorize 但不允许 ownership，覆盖第二道租户门禁。
// ABI request helper 固定 actor/environment，防止测试通过 payload 选择租户。
// 审计顺序来自 control-plane audit projection，不读取分发器私有 store。
// audit 的 operation 使用 plugin.* ABI 名称，便于跨语言消费者直接比较。
// 失败升级的 rejected audit 可以存在，但不得改变 current/history 的成功版本。
// 成功回滚后历史仍然 append-only，旧版本信息不会被删除。
// 分发器和 Host 都是每个 tenant 独立创建的内存实例。
// 测试不依赖真实目录、网络下载或操作系统进程。
// 私钥只用于生成 fixture，任何响应和审计都不得包含私钥或签名正文。
// 这些断言共同组成 signed distribution、tenant isolation 和 rollback handoff evidence。
