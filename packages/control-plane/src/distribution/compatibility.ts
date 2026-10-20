/**
 * 实现远程 artifact 的 host/API、版本、依赖和 capability 兼容性检查。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { PluginManifest } from '@iar/contracts';
import type { CapabilityChange, CapabilityChangeApproval, DistributionCompatibility, DistributionResult, SignedPluginArtifact } from './types.js';

/**
 * 检查 artifact 是否能被当前 host 和依赖视图接受。
 * @param artifact - 已通过签名验证的 artifact
 * @param context - 当前 host、安装版本和依赖视图
 * @returns 兼容成功或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function checkCompatibility(artifact: SignedPluginArtifact, context: DistributionCompatibility): DistributionResult<true> {
  try {
    if (artifact.manifest.apiVersion !== context.hostApiVersion || !parseVersion(artifact.manifest.version)) return { ok: false, reasonCode: 'version_incompatible' }; // API 或版本不兼容即拒绝。
    if (hasDuplicateOrSelfDependency(artifact)) return { ok: false, reasonCode: 'dependency_cycle' }; // 重复边和自环不可安装。
    if (hasUnavailableDependency(artifact, context)) return { ok: false, reasonCode: 'dependency_unavailable' }; // 缺失依赖不可安装。
    if (hasDependencyCycle(artifact, context)) return { ok: false, reasonCode: 'dependency_cycle' }; // 跨插件回边不可安装。
    const current = context.installed.get(artifact.manifest.pluginId);
    if (current?.version === artifact.manifest.version) return { ok: false, reasonCode: 'version_incompatible' }; // 同版本不重复执行生命周期。
    return { ok: true, value: true };
  } catch {
    // 外部 compatibility view 不可信时保持 fail-closed。
    return { ok: false, reasonCode: 'artifact_input_invalid' };
  }
}

/**
 * 拒绝重复边和自依赖，保持安装图语义唯一。
 * @param artifact - 已签名的候选 artifact
 * @returns 是否存在重复或自依赖
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasDuplicateOrSelfDependency(artifact: SignedPluginArtifact): boolean {
  // 重复边改变拓扑排序，自依赖直接形成环。
  const dependencies = artifact.manifest.dependencies;
  return new Set(dependencies).size !== dependencies.length || dependencies.includes(artifact.manifest.pluginId);
}

/**
 * 确认所有依赖都来自当前已安装或受信任可用集合。
 * @param artifact - 已签名的候选 artifact
 * @param context - 当前依赖上下文
 * @returns 是否存在不可用依赖
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasUnavailableDependency(artifact: SignedPluginArtifact, context: DistributionCompatibility): boolean {
  // 依赖只能来自受信任可用集合或已安装注册表。
  const available = new Set([...context.availableDependencies, ...context.installed.keys()]);
  return artifact.manifest.dependencies.some((dependency) => !available.has(dependency));
}

/**
 * 把现有依赖图和待安装节点合并后检测跨插件循环。
 * @param artifact - 已签名的候选 artifact
 * @param context - 当前依赖上下文
 * @returns 是否存在依赖循环
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasDependencyCycle(artifact: SignedPluginArtifact, context: DistributionCompatibility): boolean {
  // 将候选节点并入快照后，统一检测跨插件回边。
  const graph = new Map(context.dependencyGraph ?? []);
  for (const [pluginId, manifest] of context.installed) graph.set(pluginId, manifest.dependencies);
  graph.set(artifact.manifest.pluginId, artifact.manifest.dependencies);
  return hasCycle(artifact.manifest.pluginId, artifact.manifest.pluginId, graph, new Set());
}

/**
 * 比较旧/新 Manifest 的 capability 集合，并校验精确审批。
 * @param previous - 当前已安装 Manifest
 * @param next - 待安装的新 Manifest
 * @param approval - 可选的精确能力变更审批
 * @returns capability diff 或稳定拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function approveCapabilityChange(previous: PluginManifest, next: PluginManifest, approval?: CapabilityChangeApproval): DistributionResult<CapabilityChange> {
  try {
    const oldCapabilities = [...new Set(previous.capabilities)].sort();
    const newCapabilities = [...new Set(next.capabilities)].sort();
    const added = newCapabilities.filter((capability) => !oldCapabilities.includes(capability));
    const removed = oldCapabilities.filter((capability) => !newCapabilities.includes(capability));
    // capability 收缩不需要扩大权限审批，但仍返回完整 diff 供审计。
    if (added.length === 0) return { ok: true, value: { added, removed } };
    // capability 扩大必须显式批准，不能以默认值放行。
    if (!approval || !approval.approved) return { ok: false, reasonCode: 'capability_approval_required', details: { added } };
    const approvedOld = [...new Set(approval.oldCapabilities)].sort();
    const approvedNew = [...new Set(approval.newCapabilities)].sort();
    // 审批绑定完整前后集合，防止把旧审批复用于另一个权限变更。
    if (!sameList(approvedOld, oldCapabilities) || !sameList(approvedNew, newCapabilities)) return { ok: false, reasonCode: 'capability_approval_mismatch' };
    return { ok: true, value: { added, removed } };
  } catch {
    return { ok: false, reasonCode: 'artifact_input_invalid' };
  }
}

/**
 * 判断两个已排序字符串集合是否完全一致。
 * @param left - 左侧集合
 * @param right - 右侧集合
 * @returns 是否逐项一致
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 解析严格的三段式非负版本。
 * @param value - 版本文本
 * @returns 三段数字或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined; // 非三段式版本没有确定的排序语义。
  const parsed = match.slice(1).map(Number);
  return parsed.every((part) => Number.isSafeInteger(part)) ? parsed as [number, number, number] : undefined; // 超出安全整数范围也拒绝。
}

/**
 * 从指定节点深度优先检测依赖图是否回到起点。
 * @param start - 依赖检查起点
 * @param current - 当前遍历节点
 * @param graph - 插件到依赖的图
 * @param visiting - 当前递归路径
 * @returns 是否检测到循环
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasCycle(start: string, current: string, graph: ReadonlyMap<string, readonly string[]>, visiting: Set<string>): boolean {
  if (visiting.has(current)) return current === start; // 回到当前路径节点即形成环。
  visiting.add(current);
  for (const dependency of graph.get(current) ?? []) {
    if (hasCycle(start, dependency, graph, visiting)) return true;
  }
  visiting.delete(current);
  return false;
}
