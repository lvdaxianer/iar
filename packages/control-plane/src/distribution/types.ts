/**
 * 定义远程插件分发的签名、兼容性、审批和审计类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { KeyObject } from 'node:crypto';
import type { IarApiVersion, PluginManifest } from '@iar/contracts';

/** 分发边界使用的稳定错误码。 */
export type DistributionErrorCode =
  | 'artifact_input_invalid'
  | 'manifest_invalid'
  | 'signer_untrusted'
  | 'signature_invalid'
  | 'artifact_digest_mismatch'
  | 'version_incompatible'
  | 'dependency_unavailable'
  | 'dependency_cycle'
  | 'capability_approval_required'
  | 'capability_approval_mismatch'
  | 'plugin_not_found'
  | 'plugin_install_failed'
  | 'plugin_upgrade_failed'
  | 'rollback_invalid';

// Success results carry only validated values.
// Failure results carry stable machine-readable reason codes.
// Details remain bounded strings or string arrays.
// No public result branch carries raw exceptions.
// The union is shared by cryptographic and lifecycle boundaries.
/** 分发 API 的成功或稳定拒绝结果。 */
export type DistributionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: DistributionErrorCode; details?: Record<string, string | string[]> };

/** 被签名的远程插件 artifact；不携带私钥或原始 bundle 内容。 */
export type SignedPluginArtifact = {
  /** 固定 artifact 协议版本。 */
  artifactVersion: 'v1';
  /** 用于查找可信公钥的稳定 signer 标识。 */
  signerKeyId: string;
  /** Ed25519 base64 签名正文。 */
  signature: string;
  /** 对外部 bundle 的 SHA-256 摘要。 */
  bundleDigest: string;
  /** 已通过 contracts 校验的插件声明。 */
  manifest: PluginManifest;
};

/** 分发器信任的 Ed25519 公钥。 */
export type TrustedSigner = KeyObject | string | Buffer;

/** 兼容性检查所需的 host、依赖和已安装版本视图。 */
export type DistributionCompatibility = {
  /** 当前宿主解释 Manifest 的 API 版本。 */
  hostApiVersion: IarApiVersion;
  /** 当前已安装插件版本快照。 */
  installed: ReadonlyMap<string, PluginManifest>;
  /** 允许作为依赖解析的插件标识。 */
  availableDependencies: ReadonlySet<string>;
  /** 可选的外部依赖图快照。 */
  dependencyGraph?: ReadonlyMap<string, readonly string[]>;
};

/** capability 变更审批必须绑定完整的旧集合和新集合。 */
export type CapabilityChangeApproval = {
  /** 审批记录的稳定标识。 */
  approvalId: string;
  /** 执行审批的主体标识。 */
  actorId: string;
  /** 是否明确批准本次变更。 */
  approved: boolean;
  /** 人类可读的审批理由。 */
  reason: string;
  /** 审批时观察到的旧 capability 集合。 */
  oldCapabilities: string[];
  /** 审批时观察到的新 capability 集合。 */
  newCapabilities: string[];
};

/** 兼容性检查通过后保留的 capability diff。 */
export type CapabilityChange = {
  /** 新增的 capability。 */
  added: string[];
  /** 删除的 capability。 */
  removed: string[];
};

/** 分发器当前持有的不可变 artifact 记录。 */
export type DistributionRecord = {
  /** 完整签名 artifact 的安全副本。 */
  artifact: SignedPluginArtifact;
  /** Manifest 的安全副本。 */
  manifest: PluginManifest;
  /** 分发层允许的当前状态。 */
  state: 'enabled' | 'disabled';
};

/** 分发审计操作类型。 */
export type DistributionAuditOperation = 'install' | 'upgrade' | 'rollback' | 'rejected';

/** 不包含签名正文、私钥或 bundle 的 append-only 审计记录。 */
export type DistributionAuditRecord = {
  /** 审计记录的稳定标识。 */
  auditId: string;
  /** 审计所属插件。 */
  pluginId: string;
  /** 发生的分发操作。 */
  operation: DistributionAuditOperation;
  /** 操作结果。 */
  result: 'accepted' | 'rejected';
  /** 目标版本。 */
  version: string;
  /** 可选的前一版本。 */
  previousVersion?: string;
  /** 失败时的稳定错误码。 */
  reasonCode?: DistributionErrorCode;
  /** 签名 payload 摘要，不是签名正文。 */
  signatureDigest?: string;
  /** 记录创建时间。 */
  occurredAt: string;
};

/** 可注入的分发状态存储。 */
export interface DistributionStore {
  /**
   * 读取当前版本的安全副本。
   * @param pluginId - 插件稳定标识
   * @returns 当前分发记录或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  current(pluginId: string): DistributionRecord | undefined;
  /**
   * 读取按提交顺序保存的 immutable 历史。
   * @param pluginId - 插件稳定标识
   * @returns 版本历史副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  history(pluginId: string): readonly DistributionRecord[];
  /**
   * 读取全量或按插件过滤的审计。
   * @param pluginId - 可选插件稳定标识
   * @returns 审计记录副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  audit(pluginId?: string): readonly DistributionAuditRecord[];
  /**
   * 提交当前版本和可选的前一版本。
   * @param pluginId - 插件稳定标识
   * @param current - 新当前版本
   * @param previous - 可选旧版本
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  commit(pluginId: string, current: DistributionRecord, previous?: DistributionRecord): void;
  /**
   * 原子提交当前版本、历史版本和成功审计。
   * @param pluginId - 插件稳定标识
   * @param current - 新当前版本
   * @param previous - 可选旧版本
   * @param audit - 与提交绑定的 accepted 审计
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  commitAccepted(pluginId: string, current: DistributionRecord, previous: DistributionRecord | undefined, audit: DistributionAuditRecord): void;
  /**
   * 追加 rejected 或其他非事务成功审计。
   * @param record - 已脱敏审计记录
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  appendAudit(record: DistributionAuditRecord): void;
}

/** RemotePluginDistributor 的构造参数。 */
export type RemotePluginDistributorOptions = {
  /** 接收分发生命周期操作的本地宿主。 */
  host: import('@iar/plugins').PluginHost;
  /** signerKeyId 到 Ed25519 公钥的信任映射。 */
  trustedSigners: ReadonlyMap<string, TrustedSigner>;
  /** 宿主 API、依赖和已安装版本上下文。 */
  compatibility: DistributionCompatibility;
  /** 可选的持久化或测试 store。 */
  store?: DistributionStore;
};
