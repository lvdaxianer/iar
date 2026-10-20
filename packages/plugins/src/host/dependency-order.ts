/**
 * 提供插件依赖图的确定性拓扑排序。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ERROR_CODES, SCHEMA_VERSIONS, type ContractErrorResult, type PluginManifest } from '@iar/contracts';
import { compareStableIds } from './compare-ids.js';
import type { PluginHostResult } from './types.js';

/**
 * 构造依赖排序失败的稳定错误。
 *
 * @param code - 循环或缺失依赖错误码
 * @param pluginId - 发生错误的插件标识
 * @param dependencyId - 可选的缺失依赖标识
 * @returns 结构化依赖错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function dependencyError(
  code: typeof ERROR_CODES.PLUGIN_DEPENDENCY_CYCLE | typeof ERROR_CODES.PLUGIN_DEPENDENCY_MISSING,
  pluginId: string,
  dependencyId?: string
): ContractErrorResult {
  const message = code === ERROR_CODES.PLUGIN_DEPENDENCY_CYCLE ? '插件依赖存在循环' : '插件依赖不存在';
  const details = dependencyId ? { pluginId, dependencyId } : { pluginId };
  return { schemaVersion: SCHEMA_VERSIONS.error, code, message, retryable: false, details };
}

/**
 * 构造批量输入重复插件标识的契约错误。
 *
 * @param pluginId - 重复出现的插件标识
 * @returns 表示重复注册的稳定错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function duplicatePluginError(pluginId: string): ContractErrorResult {
  return {
    schemaVersion: SCHEMA_VERSIONS.error,
    code: ERROR_CODES.PLUGIN_DUPLICATE_ID,
    message: '批量安装中存在重复插件标识',
    retryable: false,
    details: { pluginId }
  };
}

/**
 * 查找批量输入中的重复插件标识。
 *
 * @param manifests - 待检查的 Manifest 列表
 * @returns 第一个重复的 Manifest，未发现时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function findDuplicate(manifests: PluginManifest[]): PluginManifest | undefined {
  const seen = new Set<string>();
  for (const manifest of manifests) {
    // Set 让重复标识检查保持线性复杂度，避免大批量输入退化为 O(n²)。
    if (seen.has(manifest.pluginId)) return manifest;
    seen.add(manifest.pluginId);
  }
  return undefined;
}

/**
 * 将插件 Manifest 按依赖先后排序，且不修改调用方输入。
 *
 * @param manifests - 本次待安装的插件 Manifest
 * @param existingIds - 当前注册表中已经安装的插件标识
 * @returns 依赖优先的稳定顺序或结构化依赖错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function sortPluginManifests(manifests: PluginManifest[], existingIds: ReadonlySet<string>): PluginHostResult<PluginManifest[]> {
  const duplicate = findDuplicate(manifests);
  // 批量重复标识不是依赖缺失，必须返回专用错误码。
  if (duplicate) return { ok: false, error: duplicatePluginError(duplicate.pluginId) };
  const byId = new Map(manifests.map((manifest) => [manifest.pluginId, manifest]));
  const context: VisitContext = { visiting: new Set(), visited: new Set(), sorted: [] };
  return sortRoots(manifests, byId, existingIds, context);
}

/**
 * 按固定标识顺序访问所有根节点。
 *
 * @param manifests - 待排序的 Manifest 列表
 * @param byId - Manifest 标识索引
 * @param existingIds - 当前注册表中的插件标识
 * @param context - DFS 访问状态
 * @returns 已排序的 Manifest 或依赖错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function sortRoots(
  manifests: PluginManifest[],
  byId: ReadonlyMap<string, PluginManifest>,
  existingIds: ReadonlySet<string>,
  context: VisitContext
): PluginHostResult<PluginManifest[]> {
  for (const manifest of [...manifests].sort((left, right) => compareStableIds(left.pluginId, right.pluginId))) {
    const result = visit(manifest, byId, existingIds, context);
    // 任一依赖失败都取消整个排序事务。
    if (!result.ok) return result;
  }
  return { ok: true, value: context.sorted };
}

/**
 * 深度优先访问依赖并记录拓扑顺序。
 *
 * @param manifest - 当前访问的 Manifest
 * @param byId - Manifest 标识索引
 * @param existingIds - 当前注册表中的插件标识
 * @param context - DFS 访问状态
 * @returns 访问成功或依赖错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function visit(manifest: PluginManifest, byId: ReadonlyMap<string, PluginManifest>, existingIds: ReadonlySet<string>, context: VisitContext): PluginHostResult<undefined> {
  if (context.visited.has(manifest.pluginId)) return { ok: true, value: undefined };
  if (context.visiting.has(manifest.pluginId)) return { ok: false, error: dependencyError(ERROR_CODES.PLUGIN_DEPENDENCY_CYCLE, manifest.pluginId) };
  context.visiting.add(manifest.pluginId);
  const dependencyResult = visitDependencies(manifest, byId, existingIds, context);
  if (!dependencyResult.ok) return dependencyResult;
  context.visiting.delete(manifest.pluginId);
  context.visited.add(manifest.pluginId);
  context.sorted.push(manifest);
  return { ok: true, value: undefined };
}

/**
 * 访问单个插件的全部依赖。
 *
 * @param manifest - 当前访问的插件 Manifest
 * @param byId - Manifest 标识索引
 * @param existingIds - 当前注册表中的插件标识
 * @param context - DFS 访问状态
 * @returns 依赖访问结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function visitDependencies(
  manifest: PluginManifest,
  byId: ReadonlyMap<string, PluginManifest>,
  existingIds: ReadonlySet<string>,
  context: VisitContext
): PluginHostResult<undefined> {
  for (const dependencyId of [...manifest.dependencies].sort(compareStableIds)) {
    const dependency = byId.get(dependencyId);
    // 当前批次包含依赖时递归访问并确保依赖先入序列。
    if (dependency) {
      const result = visit(dependency, byId, existingIds, context);
      if (!result.ok) return result;
    // 既不在当前批次也不在注册表时拒绝安装。
    } else if (!existingIds.has(dependencyId)) {
      return { ok: false, error: dependencyError(ERROR_CODES.PLUGIN_DEPENDENCY_MISSING, manifest.pluginId, dependencyId) };
    }
  }
  return { ok: true, value: undefined };
}

/** DFS 拓扑排序共享的可变访问状态。 */
type VisitContext = {
  visiting: Set<string>;
  visited: Set<string>;
  sorted: PluginManifest[];
};
