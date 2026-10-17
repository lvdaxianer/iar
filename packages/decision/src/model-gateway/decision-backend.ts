/**
 * 解析 Function/Plugin 决策阶段实际使用的模型后端。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ModelProfile, ModelProfileRegistry } from '../model-profile.js';
import type { DecisionBackend } from '../types.js';

/** 支持后端解析的决策 role。 */
export type DecisionBackendRole = 'function.select' | 'plugin.select';

/** 决策后端解析结果。 */
export type DecisionBackendResolution = {
  /** 产生决策的 role。 */
  role: DecisionBackendRole;
  /** 选中的决策后端。 */
  backend: DecisionBackend;
  /** 选中 primary profile 的稳定标识。 */
  profileId: string;
};

/** 决策后端解析失败时的稳定错误码。 */
export type DecisionBackendResolutionErrorCode = 'model.no_profile';

/**
 * 决策 role 没有可用 primary profile 时的稳定配置错误。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class DecisionBackendResolutionError extends Error {
  /** 供调用方稳定判断的错误码。 */
  public readonly code: DecisionBackendResolutionErrorCode = 'model.no_profile';

  /**
   * 创建不泄露 provider 异常的决策后端配置错误。
   * @param role - 未配置可用 primary 的决策 role
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(role: DecisionBackendRole) {
    super(`决策 role 未配置可用 backend: ${role}`);
    this.name = 'DecisionBackendResolutionError';
  }
}

/**
 * 按固定优先级为决策 role 解析一个 primary backend。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class DecisionBackendResolver {
  /**
   * 创建绑定 profile registry 的决策后端解析器。
   * @param registry - 已完成配置校验的 profile registry
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly registry: ModelProfileRegistry) {}

  /**
   * 按 JEV 优先、Intent Model 其次解析决策后端。
   * @param role - 要解析的 Function 或 Plugin 决策 role
   * @returns backend、role 和 primary profile 标识
   * @throws DecisionBackendResolutionError 当两个 backend 都没有 primary
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public resolve(role: DecisionBackendRole): DecisionBackendResolution {
    const profiles = this.registry.list();
    const profile = resolvePrimaryProfile(profiles, role, 'jev') ?? resolvePrimaryProfile(profiles, role, 'intent-model');
    if (!profile) throw new DecisionBackendResolutionError(role);
    return { role, backend: resolveBackend(profile), profileId: profile.profileId };
  }
}

/**
 * 从同一 role/backend 的关系图中找出未被 fallback 引用的 primary。
 * @param profiles - registry 的 profile 快照
 * @param role - 要解析的决策 role
 * @param backend - 要解析的 backend
 * @returns 该 role/backend 的 primary profile，找不到时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function resolvePrimaryProfile(profiles: readonly ModelProfile[], role: DecisionBackendRole, backend: DecisionBackend): ModelProfile | undefined {
  const group = profiles.filter((profile) => profile.role === role && resolveBackend(profile) === backend);
  const fallbackIds = new Set(group.flatMap((profile) => profile.fallbackProfileId ? [profile.fallbackProfileId] : []));
  return group.find((profile) => !fallbackIds.has(profile.profileId));
}

/**
 * 返回 profile 声明的 backend，兼容完全缺失字段的 legacy JEV 配置。
 * @param profile - 已通过 registry 校验的 profile
 * @returns profile 的有效决策 backend
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function resolveBackend(profile: ModelProfile): DecisionBackend {
  return profile.decisionBackend ?? 'jev';
}
