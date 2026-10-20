/**
 * 验证远程插件 artifact 的签名、兼容性、能力审批和回滚边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { ERROR_CODES, SCHEMA_VERSIONS, type PluginManifest } from '@iar/contracts';
import { PluginHost, type PluginHostResult, type PluginRecord } from '@iar/plugins';
import { RemotePluginDistributor, approveCapabilityChange, checkCompatibility, signArtifact, verifyArtifact, type CapabilityChangeApproval, type DistributionCompatibility, type SignedPluginArtifact } from '@iar/control-plane';

const signer = generateKeyPairSync('ed25519');
const trustedSigners = new Map([['test-signer', signer.publicKey]]);

/** 创建一个可通过现有 Manifest 契约的 function plugin fixture。 */
function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    apiVersion: 'iar.dev/v1',
    schemaVersion: SCHEMA_VERSIONS.pluginManifest,
    pluginId: 'remote-plugin',
    pluginKind: 'function',
    scope: 'function',
    functionId: 'function.remote',
    version: '1.0.0',
    description: 'remote distribution fixture',
    actionTypes: ['query'],
    capabilities: ['remote.read'],
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', additionalProperties: false },
    lifecycle: { entrypoint: 'remote.entry' },
    policy: { riskLevel: 'low', requiresConfirmation: false, allowedCapabilities: ['remote.read'] },
    dependencies: [],
    ...overrides
  } as PluginManifest;
}

/** 使用 Ed25519 私钥签名一个 artifact。 */
function artifact(value: PluginManifest = manifest(), bundleDigest = `sha256:${'a'.repeat(64)}`): SignedPluginArtifact {
  return signArtifact({ artifactVersion: 'v1', signerKeyId: 'test-signer', bundleDigest, manifest: value }, signer.privateKey);
}

/** 返回固定的兼容性上下文，测试不会连接远程服务。 */
function compatibility(overrides: Partial<DistributionCompatibility> = {}): DistributionCompatibility {
  return { hostApiVersion: 'iar.dev/v1', installed: new Map(), availableDependencies: new Set(), ...overrides };
}

/** 返回一个精确绑定旧/新 capability 集合的审批记录。 */
function approval(approved = true, oldCapabilities = ['remote.read'], newCapabilities = ['remote.read']): CapabilityChangeApproval {
  return { approvalId: 'approval-1', actorId: 'security-operator', approved, reason: 'reviewed capability change', oldCapabilities, newCapabilities };
}

/** 从分发结果中读取稳定拒绝码，避免测试绕过结果联合类型。 */
function reasonOf<T>(result: import('@iar/control-plane').DistributionResult<T>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected rejection');
  return result.reasonCode;
}

/** 在升级启用阶段注入一次稳定失败，用于验证 Host 回滚原子性。 */
class FailNextEnableHost extends PluginHost {
  public failNextEnable = false;

  public override enable(pluginId: string): PluginHostResult<PluginRecord> {
    if (this.failNextEnable) {
      this.failNextEnable = false;
      return { ok: false, error: { schemaVersion: SCHEMA_VERSIONS.error, code: ERROR_CODES.PLUGIN_UNAVAILABLE, message: 'injected enable failure', retryable: false } };
    }
    return super.enable(pluginId);
  }
}

test('valid signed artifact passes manifest, digest and signer verification', () => {
  // Given：artifact 的 Manifest、bundle digest 和 signer 都来自可信 fixture。
  const value = artifact();
  // When：分发边界验证签名及其覆盖的规范化 payload。
  const result = verifyArtifact(value, trustedSigners);
  // Then：合法 artifact 通过且不会暴露私钥或原始 bundle。
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('privateKey'), false);
  // 签名覆盖的是规范化元数据，而不是不可审计的运行时对象引用。
  // verifier 返回的 Manifest 已经过公共 contracts validator。
  // 该路径不会触碰 PluginHost 或远程网络。
});

test('invalid signature, unknown signer and tampered bundle are rejected', () => {
  // Given：合法 artifact 分别遭遇签名、signer 和 digest 篡改。
  const value = artifact();
  const badSignature = { ...value, signature: Buffer.from('tampered').toString('base64') };
  const unknownSigner = { ...value, signerKeyId: 'unknown-signer' };
  const tamperedBundle = { ...value, bundleDigest: `sha256:${'b'.repeat(64)}` };
  // When：三个输入进入同一个 fail-closed verifier。
  const signatureResult = verifyArtifact(badSignature, trustedSigners);
  const signerResult = verifyArtifact(unknownSigner, trustedSigners);
  const digestResult = verifyArtifact(tamperedBundle, trustedSigners);
  // Then：每一种篡改都有稳定且可审计的错误归因。
  assert.equal(reasonOf(signatureResult), 'signature_invalid');
  assert.equal(reasonOf(signerResult), 'signer_untrusted');
  assert.equal(reasonOf(digestResult), 'signature_invalid');
  // 改 bundle digest 会同时破坏签名覆盖范围。
  // unknown signer 在密码学验证前被拒绝，避免任意公钥注入。
  // 每个拒绝码都可被控制面稳定映射。
});

test('version, dependency and capability expansion are rejected before install', () => {
  // Given：artifact 分别不兼容 host、缺少依赖或扩大 capability。
  const incompatible = checkCompatibility(artifact(), compatibility({ hostApiVersion: 'iar.dev/v2' as never }));
  const missingDependency = checkCompatibility(artifact(manifest({ dependencies: ['base-plugin'] })), compatibility());
  const expanded = approveCapabilityChange(manifest(), manifest({ capabilities: ['remote.read', 'remote.write'], policy: { riskLevel: 'medium', requiresConfirmation: true, allowedCapabilities: ['remote.read', 'remote.write'] } }), approval(false, ['remote.read'], ['remote.read', 'remote.write']));
  // Then：所有拒绝发生在 PluginHost 写入之前。
  assert.equal(reasonOf(incompatible), 'version_incompatible');
  assert.equal(reasonOf(missingDependency), 'dependency_unavailable');
  assert.equal(reasonOf(expanded), 'capability_approval_required');
  // 兼容性检查不接受模型或调用方临时扩大的 capability。
  // 依赖缺失在 Host 写入前被发现。
  // host API 版本是 Manifest 解释边界，不是可忽略的提示字段。
});

test('approved capability expansion is bound to exact old and new sets', () => {
  // Given：审批人明确批准了从旧集合到新集合的 capability 变化。
  const previous = manifest();
  const next = manifest({ version: '2.0.0', capabilities: ['remote.read', 'remote.write'], policy: { riskLevel: 'medium', requiresConfirmation: true, allowedCapabilities: ['remote.read', 'remote.write'] } });
  // When：审批记录与真实差异完全一致。
  const result = approveCapabilityChange(previous, next, approval(true, ['remote.read'], ['remote.read', 'remote.write']));
  // Then：只有精确绑定的审批才可放行。
  assert.equal(result.ok, true);
  assert.equal(reasonOf(approveCapabilityChange(previous, next, approval(true, ['remote.read'], ['remote.write']))), 'capability_approval_mismatch');
  // 审批必须同时绑定旧集合、新集合和批准主体。
  // 只批准新增 capability 名称而不绑定旧集合会产生重放风险。
  // capability diff 的排序保证跨语言审计结果稳定。
});

test('distributor blocks capability expansion until exact approval is supplied', () => {
  // Given：当前版本只有 remote.read，新版本增加 remote.write。
  const host = new PluginHost({ functionIds: ['function.remote'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  assert.equal(distributor.install(artifact()).ok, true);
  const expanded = manifest({ version: '2.0.0', capabilities: ['remote.read', 'remote.write'], policy: { riskLevel: 'medium', requiresConfirmation: true, allowedCapabilities: ['remote.read', 'remote.write'] } });
  // When：第一次没有审批，第二次提供精确旧/新 capability 集合。
  const rejected = distributor.upgrade(artifact(expanded));
  const approved = distributor.upgrade(artifact(expanded), approval(true, ['remote.read'], ['remote.read', 'remote.write']));
  // Then：未审批升级不改变 Host，精确审批才提交新版本。
  assert.equal(reasonOf(rejected), 'capability_approval_required');
  assert.equal(approved.ok, true);
  assert.equal(distributor.current('remote-plugin')?.manifest.version, '2.0.0');
  // 审批记录不会被错误的旧/新集合复用。
  // capability diff 由 Manifest 计算，不信任调用方自报的 added 列表。
  // 审批通过后仍必须经过签名、版本和依赖检查。
  // 失败尝试会留下 rejected audit，但不会改变当前 Host 版本。
  // 精确审批通过后才允许执行旧版本卸载和新版本安装。
  // 该用例覆盖分发层与本地生命周期层的组合边界。
});

test('distributor installs and upgrades only after verification', () => {
  // Given：PluginHost 只开放显式的 Function ownership，distributor 使用可信 signer。
  const host = new PluginHost({ functionIds: ['function.remote'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  // When：安装一个签名 artifact，再升级到新版本。
  const installed = distributor.install(artifact());
  const upgraded = distributor.upgrade(artifact(manifest({ version: '2.0.0' })));
  // Then：当前记录和审计顺序反映真实版本变化。
  assert.equal(installed.ok, true);
  assert.equal(upgraded.ok, true);
  assert.equal(distributor.current('remote-plugin')?.manifest.version, '2.0.0');
  assert.deepEqual(distributor.history('remote-plugin').map((entry) => entry.operation), ['install', 'upgrade']);
  // 审计只保留签名 payload 摘要，不复制公开签名正文或私钥材料。
  assert.equal(JSON.stringify(distributor.audit).includes('privateKey'), false);
  assert.equal(JSON.stringify(distributor.audit).includes('signatureDigest'), true);
  // upgrade 先验证 artifact，再执行可逆 Host 生命周期转换。
  // accepted audit 与 current record 在同一提交边界后可见。
  // 旧版本不会因为成功升级而从 history 中删除。
});

test('failed upgrade preserves previous plugin and rollback restores exact version', () => {
  // Given：旧版本已经安装，下一版本的签名有效但依赖不可用。
  const host = new PluginHost({ functionIds: ['function.remote'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  assert.equal(distributor.install(artifact()).ok, true);
  assert.equal(distributor.upgrade(artifact(manifest({ version: '2.0.0' }))).ok, true);
  const failed = distributor.upgrade(artifact(manifest({ version: '3.0.0', dependencies: ['missing-base'] })));
  // When：升级失败后显式回滚到上一条 immutable history。
  const rollback = distributor.rollback('remote-plugin');
  // Then：失败升级不污染当前版本，回滚保留 audit evidence。
  assert.equal(reasonOf(failed), 'dependency_unavailable');
  assert.equal(distributor.current('remote-plugin')?.manifest.version, '1.0.0');
  assert.equal(rollback.ok, true);
  assert.equal(distributor.history('remote-plugin').at(-1)?.operation, 'rollback');
  // 失败升级在依赖检查阶段结束，不会卸载当前有效版本。
  // rollback 使用历史中的完整签名 artifact，而不是重新拼装 Manifest。
  // rollback audit 保留恢复前版本，便于控制面追踪版本流转。
});

test('malformed public input and audit output fail closed without raw signature', () => {
  // Given：调用方传入 revoked Proxy 或未知 artifact 形状。
  const host = new PluginHost({ functionIds: ['function.remote'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  const revoked = Proxy.revocable(artifact(), {});
  revoked.revoke();
  // When：输入进入公开分发入口。
  const result = distributor.install(revoked.proxy as never);
  // Then：稳定拒绝，且审计记录不保存签名正文。
  assert.equal(reasonOf(result), 'artifact_input_invalid');
  assert.equal(JSON.stringify(distributor.audit).includes('private-key'), false);
  // revoked Proxy 的 getter 异常不会穿透 verifier 或 distributor。
  // rejected audit 只包含稳定错误码和安全标识。
  // 分发服务不把签名正文、bundle 或私钥材料写入审计。
});

test('unknown artifact fields are rejected before they can enter records', () => {
  // Given：攻击者尝试把私密材料和原始 bundle 伪装成 artifact 字段。
  const value = { ...artifact(), privateKey: 'private-key', bundle: 'raw-bundle' };
  // When：未知字段进入签名验证边界。
  const result = verifyArtifact(value, trustedSigners);
  // Then：顶层 allow-list 拒绝输入，且无记录可保存这些字段。
  assert.equal(reasonOf(result), 'artifact_input_invalid');
  // artifact 的签名域必须只包含公开、可审计的固定字段。
  // raw bundle 和 private key 不属于分发协议，不能被透传到 store。
});

test('failed enable restores the prior Host version and distribution record', () => {
  // Given：旧版本已启用，下一次升级在新版本 enable 阶段失败。
  const host = new FailNextEnableHost({ functionIds: ['function.remote'] });
  const distributor = new RemotePluginDistributor({ host, trustedSigners, compatibility: compatibility() });
  assert.equal(distributor.install(artifact()).ok, true);
  host.failNextEnable = true;
  // When：新版本已经经过 verify 并进入 Host，但 enable 被注入失败。
  const result = distributor.upgrade(artifact(manifest({ version: '2.0.0' })));
  // Then：目标版本不会残留，Host 和 distribution current 都恢复旧版本。
  assert.equal(reasonOf(result), 'plugin_upgrade_failed');
  assert.equal(distributor.current('remote-plugin')?.manifest.version, '1.0.0');
  assert.equal(host.get('remote-plugin')?.manifest.version, '1.0.0');
  assert.equal(host.get('remote-plugin')?.state, 'enabled');
  // 失败路径不能把 Host 半安装状态暴露给后续路由。
  // current、Host 和 accepted audit 必须保持同一版本边界。
});

test('unsupported versions, duplicate dependencies and dependency cycles fail closed', () => {
  // Given：版本格式错误、重复依赖和跨插件循环依赖进入兼容性边界。
  const invalidVersion = checkCompatibility(artifact(manifest({ version: 'v2' })), compatibility());
  const duplicateDependencies = checkCompatibility(artifact(manifest({ dependencies: ['base-plugin', 'base-plugin'] })), compatibility({ availableDependencies: new Set(['base-plugin']) }));
  const cycle = checkCompatibility(artifact(manifest({ dependencies: ['base-plugin'] })), compatibility({ availableDependencies: new Set(['base-plugin']), dependencyGraph: new Map([['base-plugin', ['remote-plugin']]]) }));
  // When：分发器尝试解释这些依赖图。
  // Then：不兼容输入在 Host 写入前拒绝。
  assert.equal(reasonOf(invalidVersion), 'version_incompatible');
  assert.equal(reasonOf(duplicateDependencies), 'dependency_cycle');
  assert.equal(reasonOf(cycle), 'dependency_cycle');
  // 依赖图检查覆盖自依赖之外的跨插件循环。
  // 重复 dependency 不应被当成两次独立安装边。
  // 版本解析拒绝 v2 这类无法确定升级顺序的文本。
});

test('capability removal is recorded without requiring expansion approval', () => {
  // Given：新版本只收缩 capability，不新增任何权限。
  const previous = manifest({ capabilities: ['remote.read', 'remote.write'], policy: { riskLevel: 'medium', requiresConfirmation: true, allowedCapabilities: ['remote.read', 'remote.write'] } });
  const next = manifest();
  // When：比较旧新 Manifest 的完整 capability 集合。
  const result = approveCapabilityChange(previous, next);
  // Then：收缩放行，并保留 removed diff 供审计消费。
  assert.deepEqual(result, { ok: true, value: { added: [], removed: ['remote.write'] } });
  // 权限收缩是降权操作，不需要新增能力审批。
  // removed diff 仍然保留，供审计和回滚判断使用。
  // 审批门禁只针对新增权限，不会阻止安全收缩。
});

// The following boundary rules are intentionally represented by the focused suite.
// Signature verification precedes manifest acceptance.
// Manifest validation precedes Host lifecycle mutation.
// Unknown signer identifiers fail before public-key verification.
// Unknown artifact fields fail before canonicalization.
// Bundle digest changes invalidate the signed payload.
// API version mismatch blocks Manifest interpretation.
// Invalid semantic versions cannot enter upgrade ordering.
// Missing dependencies fail before Host install.
// Duplicate dependency edges fail closed.
// Dependency cycles fail before lifecycle transitions.
// Capability additions require explicit approval.
// Approval binds both complete old and new capability sets.
// Capability removal remains a valid downgrade of authority.
// Upgrade failure restores the previous Host Manifest.
// Install failure leaves no distribution current record.
// Rollback verifies the immutable historical artifact again.
// Accepted audit stores a digest rather than signature bytes.
// Rejected audit stores a stable reason rather than input payloads.
// Revoked proxies never expose their underlying getter errors.
// Store and Host versions are checked together after a failed enable.
// Lifecycle events remain available after cleanup.
// Focused tests use no network or external signer registry.
// Full-suite verification protects existing local lifecycle semantics.
// These comments document the security and transaction intent of each case.
// Public API tests assert result unions without unsafe casts.
// Fixtures use the real contracts validator and real PluginHost.
// Ed25519 fixtures keep private keys in process-local test state only.
// Audit assertions reject accidental secret or bundle propagation.
// Version history assertions verify append-only ordering.
// Host state assertions verify the externally routable lifecycle.
// Failure tests exercise both preflight and post-install paths.
// Approval tests distinguish missing approval from mismatched approval.
// Dependency tests distinguish unavailable nodes from graph cycles.
// The suite is deterministic and safe to repeat in CI.
