/**
 * 解析 Function/Plugin 决策阶段实际使用的模型后端。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { ModelProfile, ModelProfileRegistry, ModelRole } from '../model-profile.js';
import type { DecisionBackend } from '../types.js';
import type { JsonValue } from '@iar/contracts';
import type { ModelGatewayInvocationOptions } from './types.js';

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

/** 按旧调用或 backend-aware 选项解析 primary profile。 @param registry - profile registry @param role - 模型 role @param options - 可选 backend/profile 约束 @returns primary profile 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
export function resolvePrimaryProfileForInvocation(registry: ModelProfileRegistry, role: ModelRole, options?: ModelGatewayInvocationOptions): ModelProfile | undefined {
  // 无 options 时保持旧的 registry.forRole 选择行为。
  if (!options) return resolveProfile(registry, role);
  // profileId 存在时必须同时满足 role、backend 和 primary 约束。
  if (options.profileId) return resolveProfileId(registry, role, options.profileId, options.decisionBackend);
  // 只有 backend 时在同 role/backend 图中选择 primary。
  if (options.decisionBackend) return resolvePrimaryProfileByBackend(registry.list(), role, options.decisionBackend);
  return resolveProfile(registry, role);
}

/** 读取 primary 引用的同 backend fallback profile。 @param registry - profile registry @param primary - 已选 primary @returns fallback profile 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
export function resolveFallbackProfile(registry: ModelProfileRegistry, primary: ModelProfile): ModelProfile | undefined {
  // 没有 fallback 时保持 primary 的稳定失败路径。
  if (!primary.fallbackProfileId) return undefined;
  const fallback = registry.get(primary.fallbackProfileId);
  // fallback 必须保持同 role 和同 backend，禁止跨后端降级。
  return fallback && fallback.role === primary.role && resolveDecisionBackend(fallback, primary.role) === resolveDecisionBackend(primary, primary.role) ? fallback : undefined;
}

/** 解析显式跨 backend fallback 的另一条 primary profile。 @param registry - profile registry @param primary - 已选 primary @returns 另一 backend 的 primary 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
export function resolveCrossBackendProfile(registry: ModelProfileRegistry, primary: ModelProfile): ModelProfile | undefined {
  // 只有 Function/Plugin decision role 才有平行 backend，其他 role 不允许跨 role 猜测。
  if (primary.role !== 'function.select' && primary.role !== 'plugin.select') return undefined;
  const backend = resolveDecisionBackend(primary, primary.role);
  const alternate = backend === 'jev' ? 'intent-model' : backend === 'intent-model' ? 'jev' : undefined;
  return alternate ? resolvePrimaryProfileByBackend(registry.list(), primary.role, alternate) : undefined;
}

/** 返回 profile 实际使用的决策 backend，并兼容 legacy selection profile。 @param profile - 已校验 profile @param role - 模型 role @returns backend 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
export function resolveDecisionBackend(profile: ModelProfile, role: ModelRole): DecisionBackend | undefined {
  // 显式字段优先，避免 Intent Model 被 legacy 默认覆盖。
  if (profile.decisionBackend) return profile.decisionBackend;
  // 缺失字段只对旧 selection profile 默认兼容为 JEV。
  return role === 'function.select' || role === 'plugin.select' ? 'jev' : undefined;
}

/** 创建决策 role 的严格白名单审计摘要。 @param profile - 已选 profile @param input - 已冻结 provider 输入 @param reason - 稳定失败原因 @returns 不含请求正文的审计摘要 @author lvdaxianer@yeah.net @date 2026-10-17 */
export function createDecisionAuditMetadata(profile: ModelProfile, input: JsonValue, reason?: string): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = { provider: profile.provider, candidateCount: readCandidateCount(input) };
  const backend = resolveDecisionBackend(profile, profile.role);
  const promptVersion = readPromptVersion(input);
  // 决策审计只记录稳定摘要，绝不写入 request、systemPrompt 或 candidateId。
  if (backend) metadata.decisionBackend = backend;
  if (promptVersion) metadata.promptVersion = promptVersion;
  if (reason) metadata.reason = reason;
  return metadata;
}

/** 从 JEV 或 Intent 输入读取候选数量。 @param input - 已冻结 provider 输入 @returns 候选数量 @author lvdaxianer@yeah.net @date 2026-10-17 */
function readCandidateCount(input: JsonValue): number {
  const request = isRecord(input) && isRecord(input.request) ? input.request : input;
  return isRecord(request) && Array.isArray(request.candidates) ? request.candidates.length : 0;
}

/** 读取 Intent Prompt 的固定版本，不读取 Prompt 正文。 @param input - 已冻结 provider 输入 @returns Prompt 版本或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function readPromptVersion(input: JsonValue): string | undefined {
  return isRecord(input) && typeof input.promptVersion === 'string' ? input.promptVersion : undefined;
}

/** 判断值是否为普通对象。 @param value - 未知值 @returns 是否为普通对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return resolveDecisionBackend(profile, profile.role) ?? 'jev';
}

/** 安全读取 role primary profile。 @param registry - profile registry @param role - 模型 role @returns profile 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function resolveProfile(registry: ModelProfileRegistry, role: ModelRole): ModelProfile | undefined {
  try {
    return registry.forRole(role);
  } catch {
    return undefined;
  }
}

/** 按 profileId 严格解析 primary profile。 @param registry - profile registry @param role - 模型 role @param profileId - profile 标识 @param backend - 可选 backend @returns 匹配 profile 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function resolveProfileId(registry: ModelProfileRegistry, role: ModelRole, profileId: string, backend?: DecisionBackend): ModelProfile | undefined {
  const profiles = registry.list();
  const profile = profiles.find((item) => item.profileId === profileId);
  // profileId 必须属于选定 role/backend，且不能指向 fallback 节点。
  if (!profile || profile.role !== role || (backend && resolveDecisionBackend(profile, role) !== backend)) return undefined;
  return resolvePrimaryProfileByBackend(profiles, role, resolveDecisionBackend(profile, role))?.profileId === profileId ? profile : undefined;
}

/** 从 role/backend 关系图中寻找未被 fallback 引用的 primary。 @param profiles - profile 快照 @param role - 模型 role @param backend - backend @returns primary profile 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function resolvePrimaryProfileByBackend(profiles: readonly ModelProfile[], role: ModelRole, backend: DecisionBackend | undefined): ModelProfile | undefined {
  const group = profiles.filter((profile) => profile.role === role && resolveDecisionBackend(profile, role) === backend);
  const fallbackIds = new Set(group.flatMap((profile) => profile.fallbackProfileId ? [profile.fallbackProfileId] : []));
  return group.find((profile) => !fallbackIds.has(profile.profileId));
}
