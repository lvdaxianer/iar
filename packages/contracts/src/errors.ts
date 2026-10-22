/**
 * 定义跨包共享的稳定错误码和错误结果。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS } from './versions.js';

/** 表示契约、路由、策略和执行边界的稳定错误码。 */
export const ERROR_CODES = {
  // 重复幂等键必须返回历史结果而不是再次执行。
  ACTION_DUPLICATE: 'action.duplicate_idempotency_key',
  // 外层契约字段不满足 Schema 时使用该错误。
  CONTRACT_VALIDATION_FAILED: 'contract.validation_failed',
  // API 版本不在宿主兼容范围时使用该错误。
  INCOMPATIBLE_API_VERSION: 'contract.incompatible_api_version',
  // 嵌入的输入输出 JSON Schema 无法编译时使用该错误。
  INVALID_EMBEDDED_SCHEMA: 'contract.invalid_embedded_schema',
  // 生命周期状态转移不满足当前状态机时使用该错误。
  INVALID_LIFECYCLE_TRANSITION: 'plugin.invalid_lifecycle_transition',
  // 依赖图存在环时使用该错误。
  PLUGIN_DEPENDENCY_CYCLE: 'plugin.dependency_cycle',
  // 依赖未出现在输入或已安装注册表时使用该错误。
  PLUGIN_DEPENDENCY_MISSING: 'plugin.dependency_missing',
  // 依赖插件处于不可用状态时使用该错误。
  PLUGIN_DEPENDENCY_UNAVAILABLE: 'plugin.dependency_unavailable',
  // 批量安装中出现重复插件标识时使用该错误。
  PLUGIN_DUPLICATE_ID: 'plugin.duplicate_id',
  // Plugin ID 归一化为 OpenAI 工具名后发生冲突时使用该错误。
  PLUGIN_TOOL_NAME_CONFLICT: 'plugin.tool_name_conflict',
  // 批量安装超过宿主资源边界时使用该错误。
  PLUGIN_INSTALL_BATCH_TOO_LARGE: 'plugin.install_batch_too_large',
  // Manifest 引用不存在的 Function 时使用该错误。
  PLUGIN_FUNCTION_NOT_FOUND: 'plugin.function_not_found',
  // 插件 Function 与当前路由边界不一致时使用该错误。
  PLUGIN_OWNERSHIP_MISMATCH: 'plugin.ownership_mismatch',
  // 当前插件版本不可用时使用该错误。
  PLUGIN_UNAVAILABLE: 'plugin.unavailable',
  // Policy Gate 拒绝动作时使用该错误。
  POLICY_DENIED: 'policy.denied',
  SUBSCRIPTION_FAILED: 'subscription.failed',
  WORKFLOW_TIMEOUT: 'workflow.timeout'
} as const;

/** 表示所有稳定错误码的联合类型。 */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 表示结构化、可审计的错误结果。 */
export type ContractErrorResult = {
  schemaVersion: typeof SCHEMA_VERSIONS.error;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
};

/** 表示契约校验失败时的单个字段问题。 */
export type ContractIssue = {
  path: string;
  keyword: string;
  message: string;
};

/**
 * 表示携带稳定错误码和字段问题的契约异常。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ContractValidationError extends Error {
  /** 当前错误的稳定错误码。 */
  public readonly code: ErrorCode;

  /** 当前错误包含的字段级校验问题。 */
  public readonly issues: ContractIssue[];

  /**
   * 创建契约校验错误，并保留调用方的稳定错误码。
   *
   * @param message - 面向调用方的错误描述
   * @param issues - 字段级校验问题
   * @param code - 稳定错误码
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(message: string, issues: ContractIssue[] = [], code: ErrorCode = ERROR_CODES.CONTRACT_VALIDATION_FAILED) {
    super(message);
    this.name = 'ContractValidationError';
    this.code = code;
    this.issues = issues;
  }
}
