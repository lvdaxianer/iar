/**
 * 定义版本化 ModelProfile、配置 registry、请求脱敏和模型审计边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { DecisionBackend } from './types.js';
/** Phase 3.1 允许的模型角色集合。 */
export type ModelRole = 'semantic.extract' | 'function.select' | 'plugin.select' | 'context.compact' | 'response.generate';

/** ModelProfile 的字段白名单，显式保留可选的 decisionBackend 和 environment。 */
const MODEL_PROFILE_KEYS = ['schemaVersion', 'profileId', 'profileVersion', 'role', 'decisionBackend', 'provider', 'modelId', 'modelVersion', 'timeoutMs', 'retryPolicy', 'fallbackProfileId', 'structuredOutput', 'environment'] as const;

/** 模型调用的有限重试配置。 */
export type ModelRetryPolicy = {
  /** 允许的总尝试次数。 */
  maxAttempts: number;
  /** 尝试之间的固定退避毫秒数。 */
  backoffMs: number;
  /** 允许重试的稳定错误分类。 */
  retryOn: readonly string[];
};

/** 模型输出必须使用的结构化 Schema 配置。 */
export type StructuredOutputConfig = {
  /** 是否要求结构化输出。 */
  enabled: boolean;
  /** 结构化结果的契约标识。 */
  schemaId?: string;
};

/** 模型连接字段对应的环境变量名，不保存环境变量实际值。 */
export type ModelProfileEnvironment = {
  /** OpenAI-compatible endpoint 环境变量名。 */
  endpoint?: string;
  /** API key 环境变量名。 */
  apiKey?: string;
  /** 模型 ID 环境变量名。 */
  modelId?: string;
};

/** 一个不可变、可审计的模型角色配置。 */
export type ModelProfile = {
  /** profile 配置版本。 */
  schemaVersion: 'iar.model-profile/v1';
  /** profile 稳定标识。 */
  profileId: string;
  /** profile 语义版本。 */
  profileVersion: string;
  /** 模型角色。 */
  role: ModelRole;
  /** 选择 role 使用的显式决策后端；旧配置可暂不声明。 */
  decisionBackend?: DecisionBackend;
  /** provider 名称，不代表已调用外部服务。 */
  provider: string;
  /** 模型逻辑标识。 */
  modelId: string;
  /** 模型版本或固定 snapshot。 */
  modelVersion: string;
  /** 单次调用超时毫秒数。 */
  timeoutMs: number;
  /** retryable provider 错误策略。 */
  retryPolicy: ModelRetryPolicy;
  /** 可选的 fallback profile 元数据。 */
  fallbackProfileId?: string;
  /** 结构化输出约束。 */
  structuredOutput: StructuredOutputConfig;
  /** 非敏感环境变量名映射，实际值仅在 provider 调用时解析。 */
  environment?: ModelProfileEnvironment;
};

/** 模型配置文件的顶层结构。 */
export type ModelProfileConfig = {
  /** 配置文件版本。 */
  configVersion: 'iar.models/v1';
  /** 所有角色的 profile 列表。 */
  profiles: readonly ModelProfile[];
};

/** 模型审计结果分类。 */
export type ModelAuditOutcome = 'success' | 'rejected' | 'provider_failed' | 'timeout' | 'fallback';

/** 不包含敏感正文的模型调用审计记录。 */
export type ModelAuditEntry = {
  /** 请求链路标识。 */
  traceId: string;
  /** IAR Workflow 运行标识。 */
  runId: string;
  /** 角色和 profile 版本。 */
  role: ModelRole;
  profileId: string;
  profileVersion: string;
  /** 模型版本审计字段。 */
  modelId: string;
  modelVersion: string;
  /** 当前尝试次数。 */
  attempt: number;
  /** 稳定调用结果。 */
  outcome: ModelAuditOutcome;
  /** 是否使用了配置中的 fallback。 */
  fallbackUsed: boolean;
  /** 仅包含脱敏后的结构化 metadata。 */
  metadata: JsonValue;
};

/**
 * 从 JSON-compatible YAML 文本或对象加载并校验 ModelProfile。
 *
 * 文本源支持 ${VAR} 环境变量引用，引用值在 JSON 解析前注入；
 * 引用的环境变量未设置时 fail-closed，不静默保留占位符。
 * @param source - JSON-compatible YAML 文本或配置对象
 * @returns 深拷贝的合法 profile 列表
 * @throws Error 当配置结构、版本、profile 或引用无效
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function loadModelProfiles(source: string | unknown): ModelProfile[] {
  const parsed = typeof source === 'string' ? parseConfigText(source) : source;
  // 顶层未知字段或空 profile 必须 fail-closed，避免静默接受未声明配置。
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['configVersion', 'profiles']) || parsed.configVersion !== 'iar.models/v1' || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) throw new Error('模型配置顶层结构无效');
  const profiles = parsed.profiles.map(parseProfile);
  const ids = profiles.map((profile) => profile.profileId);
  if (new Set(ids).size !== ids.length) throw new Error('模型 profileId 重复');
  validateDecisionBackendConfiguration(profiles);
  const knownIds = new Set(ids);
  profiles.forEach((profile) => {
    validateFallbackProfile(profile, profiles, knownIds);
  });
  validatePrimaryProfiles(profiles);
  return profiles.map((profile) => structuredClone(profile));
}

/**
 * 按 role 管理不可变 ModelProfile，并解析配置中的 fallback 元数据。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ModelProfileRegistry {
  private readonly profiles: readonly ModelProfile[];

  /**
   * 创建 profile registry。
   * @param profiles - 已通过配置校验的 profile 列表
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(profiles: readonly ModelProfile[]) {
    this.profiles = loadModelProfiles({ configVersion: 'iar.models/v1', profiles });
  }

  /**
   * 返回指定 role 的主 profile，或其配置的 fallback profile。
   * @param role - 模型角色
   * @param useFallback - 是否解析该 role 配置的 fallback profile
   * @returns role 对应 profile
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public forRole(role: ModelRole, useFallback = false): ModelProfile {
    const primary = this.profiles.find((item) => item.role === role);
    if (!primary) throw new Error(`模型 role 未配置: ${role}`);
    if (useFallback && !primary.fallbackProfileId) throw new Error(`模型 role 未配置 fallback: ${role}`);
    const profile = useFallback ? this.profiles.find((item) => item.profileId === primary.fallbackProfileId) : primary;
    if (!profile) throw new Error(`模型 role 未配置: ${role}`);
    return structuredClone(profile);
  }

  /**
   * 按 profileId 读取配置。
   * @param profileId - profile 稳定标识
   * @returns profile 或 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get(profileId: string): ModelProfile | undefined {
    const profile = this.profiles.find((item) => item.profileId === profileId);
    return profile ? structuredClone(profile) : undefined;
  }

  /**
   * 返回全部 profile 的深拷贝。
   * @returns profile 快照列表
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public list(): ModelProfile[] {
    return this.profiles.map((profile) => structuredClone(profile));
  }
}

/**
 * 递归复制请求并替换敏感字段，避免原始 prompt/input 进入日志。
 * @param value - 未信任的 JSON-safe 或普通对象
 * @returns 不修改原对象的脱敏副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function redactModelRequest<T>(value: T): T {
  // 脱敏前先拒绝 Date、Map、Set、BigInt 和循环引用等非 JSON 输入。
  if (!isJsonValue(value)) throw new Error('模型请求必须是 JSON 值');
  return redactValue(value, new Set()) as T;
}

/**
 * 只保存 profile/model 版本和脱敏 metadata 的审计 recorder。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ModelAuditRecorder {
  /**
   * 创建绑定 profile registry 的审计 recorder。
   * @param registry - 已校验的 profile registry
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly registry: ModelProfileRegistry) {}

  /**
   * 创建一次不可变模型调用审计记录。
   * @param input - 调用链路、角色、结果和待脱敏 metadata
   * @returns 不包含敏感正文的审计记录
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public record(input: Omit<ModelAuditEntry, 'profileId' | 'profileVersion' | 'modelId' | 'modelVersion' | 'fallbackUsed'> & { fallbackUsed?: boolean }): ModelAuditEntry {
    if (!isRecord(input) || !isModelRole(input.role) || (input.fallbackUsed !== undefined && typeof input.fallbackUsed !== 'boolean')) throw new Error('模型审计输入无效');
    const profile = this.registry.forRole(input.role, input.fallbackUsed === true);
    const metadata = redactModelRequest(input.metadata);
    // 审计字段和脱敏 metadata 均必须经过 runtime boundary 校验。
    if (!isNonEmptyString(input.traceId) || !isNonEmptyString(input.runId) || !Number.isInteger(input.attempt) || input.attempt < 1 || !isAuditOutcome(input.outcome) || !isJsonValue(metadata)) throw new Error('模型审计输入无效');
    return {
      traceId: input.traceId,
      runId: input.runId,
      role: input.role,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      modelId: profile.modelId,
      modelVersion: profile.modelVersion,
      attempt: input.attempt,
      outcome: input.outcome,
      fallbackUsed: input.fallbackUsed === true,
      metadata
    };
  }
}

/**
 * 解析 JSON-compatible YAML 子集。
 *
 * @param source - 配置文本
 * @returns 解析后的未知对象
 * @throws Error 当文本不是合法子集或引用了未设置的环境变量
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseConfigText(source: string): unknown {
  // 环境变量引用解析放在 JSON 解析之外，保证缺失引用抛出专属错误而不是被归类为格式错误。
  const resolved = resolveEnvReferences(source);
  try {
    return JSON.parse(resolved) as unknown;
  } catch {
    // 文本不是允许的 JSON-compatible YAML 子集时拒绝加载。
    throw new Error('models.yaml 必须使用 JSON-compatible YAML 子集');
  }
}

/**
 * 把配置文本中的 ${VAR} 引用替换为对应环境变量值。
 *
 * 密钥和地址不写入配置文件，统一通过环境变量引用注入；
 * 占位符位于 JSON 字符串内部，替换值必须转义引号与反斜线以保持 JSON 合法。
 *
 * @param source - 原始配置文本
 * @returns 环境变量解析后的文本
 * @throws Error 当引用的环境变量未设置
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function resolveEnvReferences(source: string): string {
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, name: string) => {
    const value = process.env[name];
    // 缺失引用必须 fail-closed，避免密钥位置被空字符串静默顶替。
    if (value === undefined) throw new Error(`模型配置引用的环境变量未设置: ${name}`);
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
}

/**
 * 校验并复制单个 profile。
 * @param value - 未信任的 profile 输入
 * @returns 合法 profile
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseProfile(value: unknown): ModelProfile {
  // 非对象输入无法进入后续字段校验，必须统一返回 profile 错误。
  if (!isRecord(value)) throw new Error('模型 profile 无效');
  // schemaVersion 和未知字段不符合契约时拒绝整个 profile。
  if (!isProfileSchema(value)) throw new Error('模型 profile 无效');
  // role 先完成枚举校验，后续 backend 校验才能安全区分选择 role。
  if (!isModelRole(value.role)) throw new Error('模型 profile 无效');
  // backend 字段只能用于选择 role，且 own undefined 也属于显式非法声明。
  if (!isDecisionBackendForRole(value.role, value)) throw new Error('模型 profile 无效');
  // profile 标识和版本必须满足稳定审计所需的最小格式。
  if (!isProfileIdentity(value)) throw new Error('模型 profile 无效');
  // provider、模型、超时、重试和结构化输出共同构成运行时契约。
  if (!isProfileRuntimeConfig(value)) throw new Error('模型 profile 无效');
  // environment 只允许声明变量名，禁止把实际密钥或未知字段放进 profile。
  if (!isProfileEnvironmentConfig(value.environment)) throw new Error('模型 profile 无效');
  // fallbackProfileId 缺失合法，显式值则必须为非空字符串。
  if (!isProfileFallbackConfig(value)) throw new Error('模型 profile 无效');
  return structuredClone(value) as ModelProfile;
}

/** 校验 profile 的版本和字段白名单。 @param value - 未信任 profile 对象 @returns 是否符合 profile 外形 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isProfileSchema(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, MODEL_PROFILE_KEYS) && value.schemaVersion === 'iar.model-profile/v1';
}

/** 校验 profile 的稳定标识和语义版本。 @param value - 未信任 profile 对象 @returns 是否符合标识契约 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isProfileIdentity(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.profileId) && isSemver(value.profileVersion);
}

/** 校验 profile 的 provider、模型和运行时约束。 @param value - 未信任 profile 对象 @returns 是否符合运行时契约 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isProfileRuntimeConfig(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.provider) && isNonEmptyString(value.modelId) && isNonEmptyString(value.modelVersion) && isIntegerInRange(value.timeoutMs, 1, 600_000) && isRetryPolicy(value.retryPolicy) && isStructuredOutput(value.structuredOutput);
}

/** 校验 profile 的环境变量名映射。 @param value - 未知 environment 配置 @returns 是否为合法映射 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isProfileEnvironmentConfig(value: unknown): value is ModelProfileEnvironment | undefined {
  // 完全缺失 environment 继续兼容既有 profile。
  if (value === undefined) return true;
  // 显式 environment 必须是有限对象，只接受三个连接字段。
  if (!isRecord(value) || !hasOnlyKeys(value, ['endpoint', 'apiKey', 'modelId'])) return false;
  // own undefined、空字符串和非法变量名都必须 fail-closed。
  return Object.values(value).every((item) => isEnvironmentVariableName(item));
}

/** 校验 profile 的 fallback 字段边界。 @param value - 未信任 profile 对象 @returns 是否符合 fallback 契约 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isProfileFallbackConfig(value: Record<string, unknown>): boolean {
  return value.fallbackProfileId === undefined || isNonEmptyString(value.fallbackProfileId);
}

/** 校验选择 backend 的声明范围，并保留全量旧配置兼容。 @param profiles - 已解析 profile @returns 无 @throws Error 当 backend 声明不完整 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateDecisionBackendConfiguration(profiles: readonly ModelProfile[]): void {
  const hasExplicitBackend = profiles.some((profile) => isSelectionRole(profile.role) && profile.decisionBackend !== undefined);
  // 全量旧 selection profile 未声明 backend 时继续走 legacy 兼容策略。
  if (!hasExplicitBackend) return;
  // 一旦出现显式 backend，所有 selection profile 都必须完整声明 backend。
  if (profiles.some((profile) => isSelectionRole(profile.role) && profile.decisionBackend === undefined)) throw new Error('选择 role 必须声明 decisionBackend');
}

/** 校验 fallback 的存在性和 backend 关系。 @param profile - 当前 profile @param profiles - 全部 profile @param knownIds - 已知 profileId 集合 @returns 无 @throws Error 当 fallback 引用无效 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateFallbackProfile(profile: ModelProfile, profiles: readonly ModelProfile[], knownIds: ReadonlySet<string>): void {
  // 没有 fallback 声明时当前 profile 是链尾，无需继续解析关系。
  if (!profile.fallbackProfileId) return;
  const fallback = profiles.find((candidate) => candidate.profileId === profile.fallbackProfileId);
  // fallback 必须存在且保持同一 role，避免跨角色跳转。
  if (!knownIds.has(profile.fallbackProfileId) || !fallback || fallback.role !== profile.role) throw new Error(`fallback profile 引用无效: ${profile.fallbackProfileId}`);
  // fallback 必须保持同一 backend，避免隐式跨后端切换。
  if (fallback.decisionBackend !== profile.decisionBackend) throw new Error('fallback profile 必须保持同一 role/decisionBackend');
}

/** 校验 role/backend 分组的 primary 和 fallback 图。 @param profiles - 已解析 profile @returns 无 @throws Error 当关系图无效 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validatePrimaryProfiles(profiles: readonly ModelProfile[]): void {
  const groups = new Map<string, ModelProfile[]>();
  // 关系校验按 role/backend 分组，legacy selection 缺失 backend 时内部归入 jev。
  profiles.forEach((profile) => {
    const backend = getValidationBackend(profile);
    // 非选择 role 没有 backend 分组，不参与决策后端关系校验。
    if (backend === undefined) return;
    const key = `${profile.role}/${backend}`;
    const group = groups.get(key);
    // 已存在分组时追加 profile，否则创建该 role/backend 的首个分组。
    if (group) group.push(profile);
    else groups.set(key, [profile]);
  });
  // 每个分组独立校验 primary 唯一性与 fallback 图完整性。
  groups.forEach((group, key) => validateProfileGroup(key, group));
}

/** 校验一个 role/backend 分组的 primary 数量和 fallback 可达性。 @param groupKey - 分组标识 @param profiles - 分组 profile @returns 无 @throws Error 当分组关系无效 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateProfileGroup(groupKey: string, profiles: readonly ModelProfile[]): void {
  const profileMap = new Map(profiles.map((profile) => [profile.profileId, profile]));
  validateNoFallbackCycles(groupKey, profiles, profileMap);
  const fallbackIds = new Set(profiles.flatMap((profile) => profile.fallbackProfileId ? [profile.fallbackProfileId] : []));
  const primaries = profiles.filter((profile) => !fallbackIds.has(profile.profileId));
  // 一个 role/backend 分组不能暴露多个未被 fallback 引用的 primary。
  if (primaries.length > 1) throw new Error('同一 role/decisionBackend 只能有一个 primary profile');
  const primary = primaries[0];
  // 所有 profile 都被当作 fallback 引用时，分组没有合法入口。
  if (!primary) throw new Error(`role/decisionBackend 配置不存在合法 primary: ${groupKey}`);
  validateFallbackReachability(groupKey, primary, profiles.length, profileMap);
}

/** 拒绝 fallback 图中的环。 @param groupKey - 分组标识 @param profiles - 分组 profile @param profileMap - profile 索引 @returns 无 @throws Error 当存在 fallback 环 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateNoFallbackCycles(groupKey: string, profiles: readonly ModelProfile[], profileMap: ReadonlyMap<string, ModelProfile>): void {
  // 从每个 profile 出发检查局部路径，避免 fallback 环绕过 primary 检测。
  profiles.forEach((profile) => {
    const path = new Set<string>();
    let current: ModelProfile | undefined = profile;
    // 沿 fallback 链前进，直到链尾或发现重复节点。
    while (current?.fallbackProfileId) {
      // 当前节点已在本次路径中出现时，说明 fallback 图形成环。
      if (path.has(current.profileId)) throw new Error(`fallback 环: ${groupKey}`);
      path.add(current.profileId);
      current = profileMap.get(current.fallbackProfileId);
    }
  });
}

/** 确认所有 profile 都能从 primary 的 fallback 链到达。 @param groupKey - 分组标识 @param primary - 唯一 primary @param profileCount - 分组 profile 数量 @param profileMap - profile 索引 @returns 无 @throws Error 当存在不可达 profile @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateFallbackReachability(groupKey: string, primary: ModelProfile, profileCount: number, profileMap: ReadonlyMap<string, ModelProfile>): void {
  const reachable = new Set<string>([primary.profileId]);
  let current = primary;
  // 从唯一 primary 沿 fallback 链遍历，收集可审计的完整路径。
  while (current.fallbackProfileId) {
    const fallback = profileMap.get(current.fallbackProfileId);
    // 缺少目标或回到已访问节点都表示关系图不可继续解析。
    if (!fallback || reachable.has(fallback.profileId)) throw new Error(`fallback 环: ${groupKey}`);
    reachable.add(fallback.profileId);
    current = fallback;
  }
  // 分组中的每个 profile 都必须能从 primary 沿 fallback 链到达。
  if (reachable.size !== profileCount) throw new Error(`fallback profile 必须在 primary 的 fallback 图中可达: ${groupKey}`);
}

/** 校验 retry 边界。 @param value - 未信任配置 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRetryPolicy(value: unknown): value is ModelRetryPolicy {
  // retry 次数、退避和错误分类均采用有限且唯一的集合。
  if (!isRecord(value) || !hasOnlyKeys(value, ['maxAttempts', 'backoffMs', 'retryOn']) || !isIntegerInRange(value.maxAttempts, 1, 8) || !isIntegerInRange(value.backoffMs, 0, 600_000) || !Array.isArray(value.retryOn)) return false;
  return value.retryOn.length > 0 && value.retryOn.every((item) => isNonEmptyString(item)) && new Set(value.retryOn).size === value.retryOn.length;
}

/** 校验 structured output 边界。 @param value - 未信任配置 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isStructuredOutput(value: unknown): value is StructuredOutputConfig {
  // 开启结构化输出时 schemaId 是不可省略的契约锚点。
  return isRecord(value) && hasOnlyKeys(value, ['enabled', 'schemaId']) && typeof value.enabled === 'boolean' && (!value.enabled || isNonEmptyString(value.schemaId));
}

/** 递归复制并替换敏感字段。 @param value - 未信任值 @param seen - 当前递归路径 @returns 脱敏值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function redactValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? '[REDACTED]' : value;
  // seen 只表示当前递归路径；循环引用被替换但兄弟字段仍可独立展开。
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value)) {
    try { return value.map((item) => redactValue(item, seen)); } finally { seen.delete(value); }
  }
  const result: Record<string, unknown> = {};
  try { Object.entries(value).forEach(([key, item]) => { result[key] = isSensitiveKey(key) ? '[REDACTED]' : redactValue(item, seen); }); } finally { seen.delete(value); }
  return result;
}

/** 判断对象是否只包含契约声明的字段。 @param value - 未信任对象 @param keys - 允许字段 @returns 是否仅含白名单字段 @author lvdaxianer@yeah.net @date 2026-10-17 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** 判断审计结果是否属于稳定枚举。 @param value - 未知结果 @returns 是否属于 ModelAuditOutcome @author lvdaxianer@yeah.net @date 2026-10-17 */
function isAuditOutcome(value: unknown): value is ModelAuditOutcome {
  return value === 'success' || value === 'rejected' || value === 'provider_failed' || value === 'timeout' || value === 'fallback';
}

/** 判断值是否为可安全写入审计记录的 JSON 值。 @param value - 未知值 @param seen - 当前递归路径 @returns 是否为 JsonValue @author lvdaxianer@yeah.net @date 2026-10-17 */
function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  // 仅允许 plain object 和完整数组，拒绝类实例、稀疏数组及循环图。
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? Object.keys(value).length === value.length && value.every((item) => isJsonValue(item, seen)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen));
  // 当前节点校验结束后清理路径集合，允许兄弟字段复用同一对象。
  seen.delete(value);
  return valid;
}

/** 判断字段名是否携带密钥、授权或原始模型正文。 @param key - 字段名 @returns 是否敏感 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSensitiveKey(key: string): boolean {
  return /apikey|api_key|authorization|token|secret|password|cookie|credential|privatekey|private_key|rawprompt|raw_prompt|rawuserinfo|raw_user_input|prompt|userinput|user_input/i.test(key);
}

/** 判断未知值是否为普通对象。 @param value - 未知值 @returns 是否为普通对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断非空字符串。 @param value - 未知值 @returns 是否为非空字符串 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 判断配置版本是三段式语义版本。 @param value - 未知版本 @returns 是否符合 semver @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSemver(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

/** 判断环境变量名是否符合跨平台 shell 标识约束。 @param value - 未知变量名 @returns 是否为合法变量名 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isEnvironmentVariableName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** 判断 role 是否属于 Phase 3.1 允许集合。 @param value - 未知 role @returns 是否为 ModelRole @author lvdaxianer@yeah.net @date 2026-10-17 */
function isModelRole(value: unknown): value is ModelRole {
  return value === 'semantic.extract' || value === 'function.select' || value === 'plugin.select' || value === 'context.compact' || value === 'response.generate';
}

/** 判断 role 是否属于决策选择角色。 @param value - 未知 role @returns 是否为选择 role @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSelectionRole(value: ModelRole): boolean {
  return value === 'function.select' || value === 'plugin.select';
}

/** 返回关系校验使用的 backend，不改变 legacy profile 的返回字段。 @param profile - 已解析 profile @returns 分组 backend 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function getValidationBackend(profile: ModelProfile): DecisionBackend | undefined {
  // 显式 backend 直接参与关系分组，不使用 legacy 默认值覆盖它。
  if (profile.decisionBackend !== undefined) return profile.decisionBackend;
  // 只有旧 selection profile 使用内部 jev 兼容分组，返回对象本身不被修改。
  return isSelectionRole(profile.role) ? 'jev' : undefined;
}

/** 校验 backend 是否只用于选择 role，并区分字段缺失与 own undefined。 @param role - 已校验 role @param value - 未知 profile 对象 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isDecisionBackendForRole(role: ModelRole, value: Record<string, unknown>): boolean {
  // 完全缺失字段代表旧配置，允许后续按 jev 进行内部关系校验。
  if (!Object.hasOwn(value, 'decisionBackend')) return true;
  // own property 即为显式声明，undefined 或未知值都不能通过白名单校验。
  return isSelectionRole(role) && (value.decisionBackend === 'jev' || value.decisionBackend === 'intent-model');
}

/** 判断未知数值是否为指定范围内的有限整数。 @param value - 未知数值 @param minimum - 最小值 @param maximum - 最大值 @returns 是否满足范围 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}
