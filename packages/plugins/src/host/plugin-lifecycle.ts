/**
 * 提供插件生命周期状态机和依赖关系查询。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { PluginRecord, PluginState } from './types.js';

/** 允许转换到每个生命周期状态的前置状态集合。 */
export const TRANSITIONS: Record<Exclude<PluginState, 'discovered' | 'validated' | 'installed' | 'unloaded'>, PluginState[]> = {
  enabled: ['installed', 'disabled'],
  draining: ['enabled'],
  disabled: ['enabled', 'draining']
};

/**
 * 判断当前状态是否允许进入目标状态。
 *
 * @param state - 当前生命周期状态
 * @param target - 目标生命周期状态
 * @returns 是否允许状态转移
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function canTransition(state: PluginState, target: keyof typeof TRANSITIONS): boolean {
  return TRANSITIONS[target].includes(state);
}

/**
 * 查找第一个未启用的依赖标识。
 *
 * @param record - 待启用的插件记录
 * @param records - 当前注册表记录
 * @returns 未启用依赖标识或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function findUnavailableDependency(record: PluginRecord, records: Iterable<PluginRecord>): string | undefined {
  const recordsById = new Map([...records].map((candidate) => [candidate.manifest.pluginId, candidate]));
  return record.manifest.dependencies.find((dependencyId) => recordsById.get(dependencyId)?.state !== 'enabled');
}

/**
 * 查找仍处于 enabled 或 draining 的反向依赖。
 *
 * @param pluginId - 基础插件标识
 * @param records - 当前注册表记录
 * @returns 第一个活跃反向依赖或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function findActiveDependent(pluginId: string, records: Iterable<PluginRecord>): PluginRecord | undefined {
  return [...records].find((record) => record.manifest.dependencies.includes(pluginId) && ['enabled', 'draining'].includes(record.state));
}

/**
 * 查找任意仍声明依赖的当前记录。
 *
 * @param pluginId - 基础插件标识
 * @param records - 当前注册表记录
 * @returns 第一个反向依赖或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function findDependent(pluginId: string, records: Iterable<PluginRecord>): PluginRecord | undefined {
  return [...records].find((record) => record.manifest.dependencies.includes(pluginId));
}
