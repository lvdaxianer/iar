/**
 * 定义版本化 ModelProfile、配置 registry、请求脱敏和模型审计边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
/** Phase 3.1 允许的模型角色集合。 */
export type ModelRole = 'semantic.extract' | 'function.select' | 'plugin.select' | 'context.compact' | 'response.generate';

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
  const knownIds = new Set(ids);
  profiles.forEach((profile) => {
    // fallback 必须存在且属于同一 role，防止跨角色降级造成版本错审计。
    if (profile.fallbackProfileId && (!knownIds.has(profile.fallbackProfileId) || profiles.find((candidate) => candidate.profileId === profile.fallbackProfileId)?.role !== profile.role)) throw new Error(`fallback profile 引用无效: ${profile.fallbackProfileId}`);
  });
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
 * @param source - 配置文本
 * @returns 解析后的未知对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseConfigText(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    // 文本不是允许的 JSON-compatible YAML 子集时拒绝加载。
    throw new Error('models.yaml 必须使用 JSON-compatible YAML 子集');
  }
}

/**
 * 校验并复制单个 profile。
 * @param value - 未信任的 profile 输入
 * @returns 合法 profile
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseProfile(value: unknown): ModelProfile {
  // 任一字段类型、版本或资源边界不合法时拒绝整个 profile。
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'profileId', 'profileVersion', 'role', 'provider', 'modelId', 'modelVersion', 'timeoutMs', 'retryPolicy', 'fallbackProfileId', 'structuredOutput']) || value.schemaVersion !== 'iar.model-profile/v1' || !isModelRole(value.role) || !isNonEmptyString(value.profileId) || !isSemver(value.profileVersion) || !isNonEmptyString(value.provider) || !isNonEmptyString(value.modelId) || !isNonEmptyString(value.modelVersion) || !isIntegerInRange(value.timeoutMs, 1, 600_000) || !isRetryPolicy(value.retryPolicy) || !isStructuredOutput(value.structuredOutput) || (value.fallbackProfileId !== undefined && !isNonEmptyString(value.fallbackProfileId))) throw new Error('模型 profile 无效');
  return structuredClone(value) as ModelProfile;
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

/** 判断 role 是否属于 Phase 3.1 允许集合。 @param value - 未知 role @returns 是否为 ModelRole @author lvdaxianer@yeah.net @date 2026-10-17 */
function isModelRole(value: unknown): value is ModelRole {
  return value === 'semantic.extract' || value === 'function.select' || value === 'plugin.select' || value === 'context.compact' || value === 'response.generate';
}

/** 判断未知数值是否为指定范围内的有限整数。 @param value - 未知数值 @param minimum - 最小值 @param maximum - 最大值 @returns 是否满足范围 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}
