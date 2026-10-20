/**
 * 实现插件 Manifest 的原子安装、候选过滤和可逆生命周期。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import {
  ERROR_CODES,
  MAX_ROUTING_SCOPE_PLUGINS,
  type ContractErrorResult,
  type EventEnvelope,
  type PluginManifest
} from '@iar/contracts';
import { compareStableIds } from './compare-ids.js';
import { sortPluginManifests } from './dependency-order.js';
import { PluginEventLog } from './plugin-events.js';
import { createRecord, pluginIdOf, prepareInstall, validateInstallSet, type InstallPreparation } from './plugin-installation.js';
import { canTransition, findActiveDependent, findDependent, findUnavailableDependency } from './plugin-lifecycle.js';
import { cloneManifest, cloneRecord, hostError } from './plugin-host-support.js';
import type { PluginDescriptor, PluginDescriptorOptions, PluginHostOptions, PluginHostResult, PluginRecord } from './types.js';
/**
 * 管理当前插件能力和不可变生命周期事件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class PluginHost {
  /** 当前注册表中的插件记录。 */
  private readonly records = new Map<string, PluginRecord>();
  /** 已知 Function ID，用于安装时校验插件归属。 */
  private readonly functionIds: ReadonlySet<string>;
  /** 所有成功或拒绝的生命周期事件，卸载不会删除历史。 */
  private readonly eventLog = new PluginEventLog();
  /**
   * 创建一个带有静态 Function 边界的 PluginHost。
   *
   * @param options - 宿主 Function 注册边界
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: PluginHostOptions) {
    this.functionIds = new Set(options.functionIds);
  }
  /**
   * 返回当前插件记录，不暴露注册表内部 Map。
   *
   * @param pluginId - 插件稳定标识
   * @returns 注册记录快照，不存在时返回 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get(pluginId: string): PluginRecord | undefined {
    const record = this.records.get(pluginId);
    return record ? cloneRecord(record) : undefined;
  }
  /**
   * 返回事件日志的深拷贝快照，调用方不能修改内部历史。
   *
   * @returns 事件日志的只读数组快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get events(): readonly EventEnvelope[] {
    return this.eventLog.events;
  }
  /**
   * 返回一个插件的历史生命周期事件副本。
   *
   * @param pluginId - 插件稳定标识
   * @returns 只读事件的可变深拷贝列表
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public history(pluginId: string): EventEnvelope[] {
    return this.eventLog.history(pluginId);
  }
  /**
   * 安装单个插件，并保持与批量安装相同的原子语义。
   *
   * @param input - Manifest 或 SDK Registration 输入
   * @returns 安装后的插件记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public install(input: unknown): PluginHostResult<PluginRecord> {
    const result = this.installAll([input]);
    if (!result.ok) return result;
    const record = result.value[0];
    return record ? { ok: true, value: record } : this.reject(pluginIdOf(input), hostError(ERROR_CODES.CONTRACT_VALIDATION_FAILED, '安装结果为空'));
  }
  /**
   * 校验、排序并原子安装一组插件。
   *
   * @param inputs - Manifest 或 SDK Registration 输入列表
   * @returns 依赖优先的插件记录列表或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public installAll(inputs: unknown[]): PluginHostResult<PluginRecord[]> {
    const preparation = prepareInstall(inputs);
    // 安装校验失败时只追加拒绝事件，不改变当前注册表。
    if (!preparation.ok) return this.reject(pluginIdOf(preparation.error.details?.pluginId), preparation.error);
    return this.commitInstall(preparation.value);
  }
  /**
   * 对完整校验结果执行排序、注册和生命周期事件提交。
   *
   * @param preparation - 已完成 Manifest 校验的安装输入
   * @returns 成功的当前注册记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private commitInstall(preparation: InstallPreparation): PluginHostResult<PluginRecord[]> {
    const order = sortPluginManifests(preparation.manifests, new Set(this.records.keys()));
    // 依赖排序失败时保持批量安装原子性。
    if (!order.ok) return this.reject(pluginIdOf(order.error.details?.pluginId), order.error);
    const validation = validateInstallSet(order.value, new Set(this.records.keys()), this.functionIds);
    // 已存在插件或未知 Function 必须在写注册表前拒绝。
    if (!validation.ok) return this.reject(pluginIdOf(validation.error.details?.pluginId), validation.error);
    return this.commitRecords(order.value, preparation.handlers);
  }
  /**
   * 将已排序的插件记录一次性写入注册表并发出阶段事件。
   *
   * @param manifests - 依赖优先排列的 Manifest
   * @param handlers - 按插件标识索引的可选 Handler
   * @returns 提交后的注册记录快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private commitRecords(manifests: PluginManifest[], handlers: InstallPreparation['handlers']): PluginHostResult<PluginRecord[]> {
    const records = manifests.map((manifest) => createRecord(manifest, handlers.get(manifest.pluginId)));
    records.forEach((record) => this.records.set(record.manifest.pluginId, record));
    records.forEach((record) => this.eventLog.lifecycle(record.manifest, 'discovered'));
    records.forEach((record) => this.eventLog.lifecycle(record.manifest, 'validated'));
    records.forEach((record) => this.eventLog.lifecycle(record.manifest, 'installed'));
    return { ok: true, value: records.map(cloneRecord) };
  }
  /**
   * 启用已安装或重新启用的插件。
   *
   * @param pluginId - 插件稳定标识
   * @returns 启用后的插件记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public enable(pluginId: string): PluginHostResult<PluginRecord> {
    return this.transition(pluginId, 'enabled');
  }
  /**
   * 进入 draining，阻止新的执行但保留历史记录。
   *
   * @param pluginId - 插件稳定标识
   * @returns draining 后的插件记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public beginDrain(pluginId: string): PluginHostResult<PluginRecord> {
    return this.transition(pluginId, 'draining');
  }
  /**
   * 禁用插件当前能力，但保留注册记录供后续重新启用。
   *
   * @param pluginId - 插件稳定标识
   * @returns disabled 后的插件记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public disable(pluginId: string): PluginHostResult<PluginRecord> {
    return this.transition(pluginId, 'disabled');
  }
  /**
   * 卸载插件当前能力，同时保留不可变生命周期历史。
   *
   * @param pluginId - 插件稳定标识
   * @returns 被卸载的 Manifest 快照或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public unload(pluginId: string): PluginHostResult<PluginManifest> {
    const record = this.records.get(pluginId);
    // 未注册插件没有可撤销的当前能力。
    if (!record) return this.reject(pluginId, hostError(ERROR_CODES.PLUGIN_UNAVAILABLE, '插件当前不可用', { pluginId }));
    const stateError = ['draining', 'disabled'].includes(record.state)
      ? undefined
      : hostError(ERROR_CODES.INVALID_LIFECYCLE_TRANSITION, '插件必须先 draining 或 disabled', { pluginId });
    // 非 draining/disabled 状态不能直接卸载。
    if (stateError) return this.reject(pluginId, stateError);
    const dependentError = this.validateNoDependents(pluginId);
    // 基础插件必须等所有当前反向依赖处理完毕后卸载。
    if (dependentError) return this.reject(pluginId, dependentError);
    this.records.delete(pluginId);
    this.eventLog.lifecycle(record.manifest, 'unloaded', record.state);
    return { ok: true, value: cloneManifest(record.manifest) };
  }
  /**
   * 丢弃尚未启用的安装中间态，仅供上层事务补偿清理使用。
   *
   * @param pluginId - 插件稳定标识
   * @returns 被丢弃的 Manifest 或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public discardInstalled(pluginId: string): PluginHostResult<PluginManifest> {
    const record = this.records.get(pluginId);
    // 只有未启用的安装中间态可被事务补偿路径丢弃。
    if (!record || record.state !== 'installed') return this.reject(pluginId, hostError(ERROR_CODES.INVALID_LIFECYCLE_TRANSITION, '只允许清理 installed 中间态', { pluginId }));
    // 删除注册表记录前先保留不可变卸载事件。
    this.records.delete(pluginId);
    this.eventLog.lifecycle(record.manifest, 'unloaded', record.state);
    return { ok: true, value: cloneManifest(record.manifest) };
  }
  /**
   * 返回指定 Function 的启用业务插件，系统插件永远被排除。
   *
   * @param functionId - 目标 Function 标识
   * @returns 按稳定标识排序的候选记录快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public candidates(functionId: string): PluginRecord[] {
    return [...this.records.values()]
      .filter((record) => record.state === 'enabled')
      .filter((record) => record.manifest.pluginKind === 'function' && record.manifest.functionId === functionId)
      .sort((left, right) => compareStableIds(left.manifest.pluginId, right.manifest.pluginId))
      .map(cloneRecord);
  }

  /** 返回所有启用的业务 Plugin，供 Plugin-first 意图识别建立有限候选。 */
  public businessCandidates(): PluginRecord[] {
    return [...this.records.values()]
      .filter((record) => record.state === 'enabled' && record.manifest.pluginKind === 'function')
      .sort((left, right) => compareStableIds(left.manifest.pluginId, right.manifest.pluginId))
      .map(cloneRecord);
  }

  /** 投影当前启用且通过调用方授权的通用 Plugin 描述。 */
  public descriptors(options: PluginDescriptorOptions = {}): PluginDescriptor[] {
    const authorize = options.authorize ?? (() => true);
    return this.businessCandidates()
      .filter((record) => authorize(record))
      .slice(0, MAX_ROUTING_SCOPE_PLUGINS)
      .map((record) => descriptorOf(record));
  }
  /**
   * 解析单个候选并为 Function 归属失败留下可审计错误。
   *
   * @param functionId - 目标 Function 标识
   * @param pluginId - 待解析的插件标识
   * @returns 通过归属和启用校验的记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public resolveCandidate(functionId: string, pluginId: string): PluginHostResult<PluginRecord> {
    const record = this.records.get(pluginId);
    // 不存在或未启用的插件不能被路由。
    if (!record || record.state !== 'enabled') {
      return this.reject(pluginId, hostError(ERROR_CODES.PLUGIN_UNAVAILABLE, '插件当前不可路由', { pluginId, functionId }));
    }
    // 业务候选必须属于请求的 Function，系统插件不能越界。
    if (record.manifest.pluginKind !== 'function' || record.manifest.functionId !== functionId) {
      return this.reject(pluginId, hostError(ERROR_CODES.PLUGIN_OWNERSHIP_MISMATCH, '插件不属于目标 Function', {
        pluginId,
        expectedFunctionId: functionId,
        actualFunctionId: record.manifest.pluginKind === 'function' ? record.manifest.functionId : 'system'
      }));
    }
    return { ok: true, value: cloneRecord(record) };
  }

  /**
   * 执行一个受限生命周期转移并发出事件。
   *
   * @param pluginId - 插件稳定标识
   * @param target - 目标生命周期状态
   * @returns 转移后的插件记录或稳定错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private transition(pluginId: string, target: 'enabled' | 'draining' | 'disabled'): PluginHostResult<PluginRecord> {
    const record = this.records.get(pluginId);
    if (!record) return this.reject(pluginId, hostError(ERROR_CODES.PLUGIN_UNAVAILABLE, '插件当前不可用', { pluginId }));
    const transitionError = this.validateTransition(record, pluginId, target);
    if (transitionError) return this.reject(pluginId, transitionError);
    const previous = record.state;
    record.state = target;
    this.eventLog.lifecycle(record.manifest, target, previous);
    return { ok: true, value: cloneRecord(record) };
  }

  /**
   * 校验插件是否允许进入目标生命周期状态。
   *
   * @param record - 当前注册记录
   * @param pluginId - 插件稳定标识
   * @param target - 目标生命周期状态
   * @returns 状态错误或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private validateTransition(record: PluginRecord, pluginId: string, target: 'enabled' | 'draining' | 'disabled'): ContractErrorResult | undefined {
    if (!canTransition(record.state, target)) {
      return hostError(ERROR_CODES.INVALID_LIFECYCLE_TRANSITION, '插件生命周期转移非法', { pluginId, state: record.state, target });
    }
    return target === 'enabled' ? this.validateDependenciesEnabled(record, pluginId) : this.validateNoEnabledDependents(pluginId);
  }

  /**
   * 校验启用插件的全部依赖已经启用。
   *
   * @param record - 待启用的插件记录
   * @param pluginId - 插件稳定标识
   * @returns 依赖错误或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private validateDependenciesEnabled(record: PluginRecord, pluginId: string): ContractErrorResult | undefined {
    const dependencyId = findUnavailableDependency(record, this.records.values());
    return dependencyId
      ? hostError(ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE, '依赖插件当前未启用', { pluginId, dependencyId })
      : undefined;
  }

  /**
   * 阻止停用仍被启用依赖插件使用的基础插件。
   *
   * @param pluginId - 基础插件稳定标识
   * @returns 反向依赖错误或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private validateNoEnabledDependents(pluginId: string): ContractErrorResult | undefined {
    const dependent = findActiveDependent(pluginId, this.records.values());
    return dependent
      ? hostError(ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE, '仍有启用中的依赖插件', { pluginId, dependentId: dependent.manifest.pluginId })
      : undefined;
  }

  /**
   * 阻止卸载仍被任意当前记录依赖的基础插件。
   *
   * @param pluginId - 基础插件稳定标识
   * @returns 反向依赖错误或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private validateNoDependents(pluginId: string): ContractErrorResult | undefined {
    const dependent = findDependent(pluginId, this.records.values());
    return dependent
      ? hostError(ERROR_CODES.PLUGIN_DEPENDENCY_UNAVAILABLE, '仍有插件依赖当前插件', { pluginId, dependentId: dependent.manifest.pluginId })
      : undefined;
  }

  /**
   * 记录拒绝事件但不写入当前注册表。
   *
   * @param pluginId - 被拒绝的插件标识
   * @param error - 拒绝原因
   * @returns 失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private reject<T>(pluginId: string, error: ContractErrorResult): PluginHostResult<T> {
    this.eventLog.reject(pluginId, error.code);
    return { ok: false, error };
  }

}

/** 从宿主记录构造不包含执行 Handler 的模型描述。 */
function descriptorOf(record: PluginRecord): PluginDescriptor {
  if (record.manifest.pluginKind !== 'function') throw new Error('系统插件不能形成业务描述');
  const actionTypes = [...record.manifest.actionTypes];
  const capabilities = [...record.manifest.capabilities];
  return {
    candidateKey: opaqueCandidateKey(record.manifest.functionId, record.manifest.pluginId),
    functionId: record.manifest.functionId,
    pluginId: record.manifest.pluginId,
    description: record.manifest.description,
    actionTypes,
    capabilities,
    operationMetadata: { actionTypes: [...actionTypes], capabilities: [...capabilities], riskLevel: record.manifest.policy.riskLevel, requiresConfirmation: record.manifest.policy.requiresConfirmation }
  };
}

/** 生成不暴露业务 ID 的稳定候选键，重启后仍可重建同一映射。 */
function opaqueCandidateKey(functionId: string, pluginId: string): string {
  let hash = 2166136261;
  for (const char of `${functionId}\u0000${pluginId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `candidate-${(hash >>> 0).toString(36)}`;
}
