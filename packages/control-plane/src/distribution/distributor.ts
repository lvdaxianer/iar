/**
 * 实现远程插件的签名安装、升级、能力审批和可回滚分发服务。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { artifactDigest, verifyArtifact } from './signature.js';
import { approveCapabilityChange, checkCompatibility } from './compatibility.js';
import { InMemoryDistributionStore } from './store.js';
import type { CapabilityChangeApproval, DistributionAuditRecord, DistributionCompatibility, DistributionRecord, DistributionResult, DistributionStore, RemotePluginDistributorOptions, SignedPluginArtifact, TrustedSigner } from './types.js';
import type { PluginHost } from '@iar/plugins';
/**
 * 管理一个 PluginHost 上的远程 artifact 版本。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class RemotePluginDistributor {
  private readonly host: PluginHost;
  private readonly trustedSigners: ReadonlyMap<string, TrustedSigner>;
  private readonly compatibility: DistributionCompatibility;
  private readonly store: DistributionStore;
  /**
   * 创建使用显式 signer、兼容性视图和 Host 的分发器。
   * @param options - Host、可信 signer 和兼容性配置
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: RemotePluginDistributorOptions) {
    this.host = options.host;
    this.trustedSigners = new Map(options.trustedSigners);
    this.compatibility = { hostApiVersion: options.compatibility.hostApiVersion, installed: new Map(options.compatibility.installed), availableDependencies: new Set(options.compatibility.availableDependencies), dependencyGraph: new Map(options.compatibility.dependencyGraph ?? []) };
    this.store = options.store ?? new InMemoryDistributionStore();
  }
  /**
   * 安装并启用一个经签名和兼容性验证的 artifact。
   * @param input - 未信任远程 artifact
   * @returns 当前安装记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public install(input: unknown): DistributionResult<DistributionRecord> {
    try { return this.installVerified(input); }
    catch { return this.reject(pluginIdOf(input), 'install', 'plugin_install_failed', versionOf(input)); }
  }
  /**
   * 执行已进入异常边界的安装流程。
   * @param input - 未信任远程 artifact
   * @returns 当前安装记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private installVerified(input: unknown): DistributionResult<DistributionRecord> {
    const verified = verifyArtifact(input, this.trustedSigners);
    if (!verified.ok) return this.reject(pluginIdOf(input), 'install', verified.reasonCode, versionOf(input)); // 签名失败不触碰 Host。
    const compatibility = checkCompatibility(verified.value, this.contextFor(verified.value));
    if (!compatibility.ok) return this.reject(verified.value.manifest.pluginId, 'install', compatibility.reasonCode, verified.value.manifest.version); // 兼容性失败不写入 current。
    return this.commitInstall(verified.value);
  }

  /**
   * 将验证通过的 artifact 写入 Host，并在持久化失败时清理 Host。
   * @param artifact - 已验证的远程 artifact
   * @returns 当前安装记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private commitInstall(artifact: SignedPluginArtifact): DistributionResult<DistributionRecord> {
    const pluginId = artifact.manifest.pluginId;
    const version = artifact.manifest.version;
    const installed = this.host.install(artifact.manifest);
    if (!installed.ok) return this.reject(pluginId, 'install', 'plugin_install_failed', version); // Host 安装失败不产生 accepted audit。
    const enabled = this.host.enable(pluginId);
    if (!enabled.ok) { this.cleanupHost(pluginId); return this.reject(pluginId, 'install', 'plugin_install_failed', version); } // enable 失败必须清理中间态。
    const record: DistributionRecord = { artifact, manifest: artifact.manifest, state: 'enabled' };
    try { this.store.commitAccepted(pluginId, record, undefined, this.acceptedAudit('install', record)); }
    catch { this.cleanupHost(pluginId); return this.reject(pluginId, 'install', 'plugin_install_failed', version); } // store 失败补偿 Host。
    return { ok: true, value: structuredClone(record) };
  }

  /**
   * 验证并原子升级当前插件，capability 扩大必须有精确审批。
   * @param input - 未信任远程 artifact
   * @param approval - capability 扩大时的精确审批
   * @returns 当前升级记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public upgrade(input: unknown, approval?: CapabilityChangeApproval): DistributionResult<DistributionRecord> {
    const pluginId = pluginIdOf(input);
    try { return this.upgradeVerified(input, approval); }
    catch { const previous = this.store.current(pluginId); if (previous) this.restore(previous); return this.reject(pluginId, 'upgrade', 'plugin_upgrade_failed', versionOf(input)); }
  }

  /**
   * 执行升级前置校验并转入生命周期事务。
   * @param input - 未信任远程 artifact
   * @param approval - capability 扩大审批
   * @returns 当前升级记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private upgradeVerified(input: unknown, approval?: CapabilityChangeApproval): DistributionResult<DistributionRecord> {
    const verified = verifyArtifact(input, this.trustedSigners);
    if (!verified.ok) return this.reject(pluginIdOf(input), 'upgrade', verified.reasonCode, versionOf(input));
    const previous = this.store.current(verified.value.manifest.pluginId);
    if (!previous) return this.reject(verified.value.manifest.pluginId, 'upgrade', 'plugin_not_found', verified.value.manifest.version);
    const compatibility = checkCompatibility(verified.value, this.contextFor(verified.value));
    if (!compatibility.ok) return this.reject(verified.value.manifest.pluginId, 'upgrade', compatibility.reasonCode, verified.value.manifest.version, previous.manifest.version);
    const change = approveCapabilityChange(previous.manifest, verified.value.manifest, approval);
    if (!change.ok) return this.reject(verified.value.manifest.pluginId, 'upgrade', change.reasonCode, verified.value.manifest.version, previous.manifest.version);
    if (!this.isNewer(previous.manifest.version, verified.value.manifest.version)) return this.reject(verified.value.manifest.pluginId, 'upgrade', 'version_incompatible', verified.value.manifest.version, previous.manifest.version);
    return this.commitUpgrade(previous, verified.value);
  }

  /**
   * 替换 Host 版本，失败时先清理目标再恢复旧版本。
   * @param previous - 当前已提交版本
   * @param artifact - 已验证的新版本 artifact
   * @returns 新当前记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private commitUpgrade(previous: DistributionRecord, artifact: SignedPluginArtifact): DistributionResult<DistributionRecord> {
    const pluginId = artifact.manifest.pluginId;
    const version = artifact.manifest.version;
    if (!this.deactivate(pluginId)) return this.reject(pluginId, 'upgrade', 'plugin_upgrade_failed', version, previous.manifest.version);
    const installed = this.host.install(artifact.manifest);
    const enabled = installed.ok ? this.host.enable(pluginId) : installed;
    if (!installed.ok || !enabled.ok) { this.restore(previous); return this.reject(pluginId, 'upgrade', 'plugin_upgrade_failed', version, previous.manifest.version); }
    const current: DistributionRecord = { artifact, manifest: artifact.manifest, state: 'enabled' };
    try { this.store.commitAccepted(pluginId, current, previous, this.acceptedAudit('upgrade', current, previous.manifest.version)); }
    catch { this.cleanupHost(pluginId); this.restore(previous); return this.reject(pluginId, 'upgrade', 'plugin_upgrade_failed', version, previous.manifest.version); }
    return { ok: true, value: structuredClone(current) };
  }

  /**
   * 回滚到最近一个已提交的 immutable 版本，并保留回滚事件。
   * @param pluginId - 插件稳定标识
   * @returns 恢复后的版本记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public rollback(pluginId: string): DistributionResult<DistributionRecord> {
    try { return this.rollbackVerified(pluginId); }
    catch { return this.reject(pluginId, 'rollback', 'rollback_invalid'); }
  }

  /**
   * 校验历史版本并执行回滚事务。
   * @param pluginId - 插件稳定标识
   * @returns 恢复后的记录或稳定拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private rollbackVerified(pluginId: string): DistributionResult<DistributionRecord> {
    const current = this.store.current(pluginId);
    const previous = this.store.history(pluginId).at(-1);
    if (!current || !previous) return this.reject(pluginId, 'rollback', 'rollback_invalid', current?.manifest.version);
    const verified = verifyArtifact(previous.artifact, this.trustedSigners);
    if (!verified.ok) return this.reject(pluginId, 'rollback', verified.reasonCode, previous.manifest.version, current.manifest.version);
    if (!this.deactivate(pluginId)) return this.reject(pluginId, 'rollback', 'rollback_invalid', previous.manifest.version, current.manifest.version);
    const installed = this.host.install(previous.manifest);
    const enabled = installed.ok ? this.host.enable(pluginId) : installed;
    if (!installed.ok || !enabled.ok) { this.restore(current); return this.reject(pluginId, 'rollback', 'rollback_invalid', previous.manifest.version, current.manifest.version); }
    const restored: DistributionRecord = { artifact: verified.value, manifest: verified.value.manifest, state: 'enabled' };
    try { this.store.commitAccepted(pluginId, restored, current, this.acceptedAudit('rollback', restored, current.manifest.version)); }
    catch { this.cleanupHost(pluginId); this.restore(current); return this.reject(pluginId, 'rollback', 'rollback_invalid', previous.manifest.version, current.manifest.version); }
    return { ok: true, value: structuredClone(restored) };
  }

  /**
   * 返回当前插件版本的安全副本。
   * @param pluginId - 插件稳定标识
   * @returns 当前记录或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public current(pluginId: string): DistributionRecord | undefined {
    return this.store.current(pluginId);
  }

  /**
   * 返回插件的 append-only 分发审计。
   * @param pluginId - 插件稳定标识
   * @returns 审计记录副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public history(pluginId: string): readonly DistributionAuditRecord[] {
    return this.store.audit(pluginId);
  }

  /**
   * 返回全部分发审计，便于控制面投影。
   * @returns 所有审计记录副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get audit(): readonly DistributionAuditRecord[] {
    return this.store.audit();
  }

  /**
   * 构造包含当前已安装版本和可用依赖的兼容性视图。
   * @param artifact - 当前待处理 artifact
   * @returns 只读兼容性视图
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private contextFor(artifact: SignedPluginArtifact): DistributionCompatibility {
    const installed = new Map(this.compatibility.installed);
    const current = this.store.current(artifact.manifest.pluginId);
    if (current) installed.set(artifact.manifest.pluginId, current.manifest);
    const result: DistributionCompatibility = { hostApiVersion: this.compatibility.hostApiVersion, installed, availableDependencies: this.compatibility.availableDependencies };
    if (this.compatibility.dependencyGraph !== undefined) result.dependencyGraph = this.compatibility.dependencyGraph;
    return result;
  }

  /**
   * 停止并卸载旧版本，但不删除 PluginHost 的生命周期事件。
   * @param pluginId - 插件稳定标识
   * @returns 是否完成卸载
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private deactivate(pluginId: string): boolean {
    const record = this.host.get(pluginId);
    if (!record) return false; // 没有 Host 记录时没有可卸载能力。
    if (record.state === 'enabled' || record.state === 'draining') {
      const drained = record.state === 'enabled' ? this.host.beginDrain(pluginId) : { ok: true };
      if (!drained.ok) return false; // draining 失败时保留旧版本。
      const disabled = this.host.disable(pluginId);
      if (!disabled.ok) return false; // disable 失败时不继续卸载。
    }
    const removed = this.host.unload(pluginId);
    return removed.ok;
  }

  /**
   * 在新版本失败后恢复之前固定的 Manifest 和生命周期状态。
   * @param record - 需要恢复的旧版本记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private restore(record: DistributionRecord): void {
    try {
      this.cleanupHost(record.manifest.pluginId);
      const installed = this.host.install(record.manifest);
      if (installed.ok && record.state === 'enabled') this.host.enable(record.manifest.pluginId);
    } catch { /* 恢复失败由调用方映射为稳定拒绝，绝不泄露 Host 异常。 */ }
  }

  /**
   * 清理当前 Host 记录，覆盖 installed、enabled、draining 和 disabled 状态。
   * @param pluginId - 插件稳定标识
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private cleanupHost(pluginId: string): void {
    const record = this.host.get(pluginId);
    if (!record) return; // 无记录时补偿已经完成。
    if (record.state === 'installed') { this.host.discardInstalled(pluginId); return; } // 只清理未启用中间态。
    this.deactivate(pluginId);
  }

  /**
   * 记录成功操作，只保存签名 payload 的摘要，不保存签名正文。
   * @param operation - 成功操作类型
   * @param record - 当前版本记录
   * @param previousVersion - 可选旧版本
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private acceptedAudit(operation: 'install' | 'upgrade' | 'rollback', record: DistributionRecord, previousVersion?: string): DistributionAuditRecord {
    const { signature: _signature, ...unsigned } = record.artifact;
    const audit: DistributionAuditRecord = { auditId: `${operation}-${record.manifest.pluginId}-${record.manifest.version}-${this.store.audit().length + 1}`, pluginId: record.manifest.pluginId, operation, result: 'accepted', version: record.manifest.version, signatureDigest: artifactDigest(unsigned), occurredAt: new Date().toISOString() };
    if (previousVersion !== undefined) audit.previousVersion = previousVersion; // 升级和回滚绑定旧版本。
    return audit;
  }

  /**
   * 记录稳定拒绝，并避免保存原始输入或底层异常。
   * @param pluginId - 插件稳定标识或 unknown
   * @param operation - 触发拒绝的操作
   * @param reasonCode - 稳定拒绝码
   * @param version - 可选目标版本
   * @param previousVersion - 可选当前版本
   * @returns 稳定拒绝结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private reject(pluginId: string, operation: 'install' | 'upgrade' | 'rollback', reasonCode: DistributionAuditRecord['reasonCode'], version?: string, previousVersion?: string): DistributionResult<never> {
    const stableReason = reasonCode ?? 'artifact_input_invalid';
    try {
      const audit: DistributionAuditRecord = { auditId: `rejected-${pluginId}-${this.store.audit().length + 1}`, pluginId, operation: 'rejected', result: 'rejected', version: version ?? 'unknown', reasonCode: stableReason, occurredAt: new Date().toISOString() };
      if (previousVersion !== undefined) audit.previousVersion = previousVersion;
      this.store.appendAudit(audit);
    } catch { /* 审计存储故障不得把底层异常暴露到公开分发边界。 */ }
    return { ok: false, reasonCode: stableReason };
  }

  /**
   * 只允许严格的三段式数字版本升级。
   * @param previous - 当前版本
   * @param next - 目标版本
   * @returns 是否为严格升级
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private isNewer(previous: string, next: string): boolean {
    const left = previous.split('.').map(Number);
    const right = next.split('.').map(Number);
    return left.length === 3 && right.length === 3 && right.some((value, index) => value > (left[index] ?? -1)) && !right.some((value, index) => value < (left[index] ?? -1));
  }
}

/**
 * 从未信任输入中安全提取 pluginId，供拒绝审计使用。
 * @param input - 未信任 artifact 输入
 * @returns 合法 pluginId 或 unknown
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function pluginIdOf(input: unknown): string {
  try {
    return typeof input === 'object' && input !== null && !Array.isArray(input) && typeof (input as Record<string, unknown>).manifest === 'object' && (input as { manifest: { pluginId?: unknown } }).manifest && typeof (input as { manifest: { pluginId?: unknown } }).manifest.pluginId === 'string'
      ? (input as { manifest: { pluginId: string } }).manifest.pluginId
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 从未信任输入中安全提取版本，供拒绝审计使用。
 * @param input - 未信任 artifact 输入
 * @returns 合法版本或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function versionOf(input: unknown): string | undefined {
  try {
    return typeof input === 'object' && input !== null && !Array.isArray(input) && typeof (input as { manifest?: { version?: unknown } }).manifest?.version === 'string' ? (input as { manifest: { version: string } }).manifest.version : undefined;
  } catch {
    return undefined;
  }
}
