/**
 * 提供公共契约的运行时校验和稳定错误转换。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ContractValidationError, ERROR_CODES, type ContractErrorResult, type ContractIssue, type ErrorCode } from './errors.js';
import { CONTRACT_SCHEMAS } from './schemas.js';
import type { PluginManifest } from './types.js';
import { IAR_API_VERSION, SCHEMA_VERSIONS } from './versions.js';

/** 表示校验成功或失败的显式结果，避免以 null 表示失败。 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorResult };

/** 表示公开的契约 Schema 名称。 */
export type ContractName = keyof typeof CONTRACT_SCHEMAS;

/** 使用同一 Ajv 实例编译所有内部契约 Schema。 */
const contractAjv = new Ajv2020({ allErrors: true, strict: false });

/** 缓存编译后的公共 Schema，避免每次验证重复编译。 */
const validators = Object.fromEntries(
  Object.entries(CONTRACT_SCHEMAS).map(([name, schema]) => [name, contractAjv.compile(schema)])
) as Record<ContractName, ValidateFunction<unknown>>;

/**
 * 判断输入是否为可读取字段的 JSON 对象。
 *
 * @param value - 待判断的未知值
 * @returns 输入是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 将 Ajv 错误转换为稳定的字段问题。
 *
 * @param errors - Ajv 返回的错误列表
 * @returns IAR 统一的字段问题列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toIssues(errors: ErrorObject[] | null | undefined): ContractIssue[] {
  return (errors ?? []).map((error) => ({
    path: issuePath(error),
    keyword: error.keyword,
    message: error.message ?? '契约字段无效'
  }));
}

/**
 * 为 required 错误补上缺少的字段路径。
 *
 * @param error - Ajv 的单个错误对象
 * @returns 可读且稳定的字段路径
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function issuePath(error: ErrorObject): string {
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return `${error.instancePath}/${error.params.missingProperty}`;
  }
  return error.instancePath || '/';
}

/**
 * 构造统一的契约校验错误结果。
 *
 * @param issues - 字段级校验问题
 * @param code - 要返回的稳定错误码
 * @returns 结构化错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validationError(issues: ContractIssue[], code: ErrorCode = ERROR_CODES.CONTRACT_VALIDATION_FAILED): ContractErrorResult {
  return {
    schemaVersion: SCHEMA_VERSIONS.error,
    code,
    message: '契约校验失败',
    retryable: false,
    details: { issues }
  };
}

/**
 * 校验任意已注册的公共契约 Schema，并验证其中的 JSON Schema 字段。
 *
 * @param name - 要使用的公共 Schema 名称
 * @param input - 待校验的未知输入
 * @returns 显式的成功值或稳定错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validateContract(name: ContractName, input: unknown): ValidationResult<unknown> {
  const versionError = validateContractVersion(name, input);
  // Manifest 版本错误必须先于字段读取转换成稳定兼容性错误。
  if (versionError) return { ok: false, error: versionError };
  const validator = validators[name];
  // 先校验外层字段，避免从不完整输入读取嵌入 Schema。
  // 外层失败时不继续读取嵌入字段。
  if (!validator(input)) {
    return { ok: false, error: validationError(toIssues(validator.errors)) };
  }
  return validateValidatedContract(name, input);
}

/**
 * 校验指定公共契约的版本字段。
 *
 * @param name - 公共契约名称
 * @param input - 待校验的契约值
 * @returns 版本错误或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateContractVersion(name: ContractName, input: unknown): ContractErrorResult | undefined {
  return name === 'pluginManifest' ? validateApiVersion(input) : undefined;
}

/**
 * 校验已通过外层 Ajv 的契约内容。
 *
 * @param name - 公共契约名称
 * @param input - 已通过外层校验的契约值
 * @returns 嵌入 Schema、跨字段关系或成功结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateValidatedContract(name: ContractName, input: unknown): ValidationResult<unknown> {
  const issues = validateContractSchemas(name, input);
  // 嵌入 Schema 错误使用独立错误码，便于安装路径处理。
  if (issues.length > 0) return { ok: false, error: validationError(issues, ERROR_CODES.INVALID_EMBEDDED_SCHEMA) };
  const relationIssues = name === 'pluginManifest' ? validatePluginManifestRelations(input) : [];
  // 跨字段关系失败时拒绝 Manifest，但保留字段级诊断。
  if (relationIssues.length > 0) return { ok: false, error: validationError(relationIssues) };
  return { ok: true, value: input };
}

/**
 * 校验 Manifest 内部能力声明之间的跨字段关系。
 *
 * @param input - 已通过 Manifest 外层 Schema 的值
 * @returns 字段级关系问题列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validatePluginManifestRelations(input: unknown): ContractIssue[] {
  if (!isRecord(input) || !Array.isArray(input.capabilities) || !isRecord(input.policy)) return [];
  const capabilities = new Set(input.capabilities.filter((value): value is string => typeof value === 'string'));
  const allowedCapabilities = Array.isArray(input.policy.allowedCapabilities)
    ? input.policy.allowedCapabilities.filter((value): value is string => typeof value === 'string')
    : [];
  const unauthorized = allowedCapabilities.filter((capability) => !capabilities.has(capability));
  const issues: ContractIssue[] = unauthorized.length > 0
    ? [{ path: '/policy/allowedCapabilities', keyword: 'subset', message: 'Policy 能力必须属于 Manifest capabilities' }]
    : [];
  if ((input.policy.riskLevel === 'high' || input.policy.riskLevel === 'critical') && input.policy.requiresConfirmation !== true) {
    issues.push({ path: '/policy/requiresConfirmation', keyword: 'requiresConfirmation', message: '高风险插件必须要求确认' });
  }
  return issues;
}

/**
 * 校验嵌入 Manifest 的 JSON Schema 文档。
 *
 * @param value - 待校验的嵌入 Schema
 * @param field - Schema 在公共契约中的字段名
 * @returns 字段级问题列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateEmbeddedSchema(value: unknown, field: string): ContractIssue[] {
  try {
    // 非对象或不符合 Draft 2020-12 meta-schema 的值都拒绝。
    if (!isRecord(value) || !contractAjv.validateSchema(value)) {
      return [{ path: `/${field}`, keyword: 'schema', message: '嵌入的 JSON Schema 无效' }];
    }
  } catch {
    // 未知 $schema 引用等 Ajv 异常也转换成稳定错误，而不向上泄漏实现异常。
    return [{ path: `/${field}`, keyword: 'schema', message: '嵌入的 JSON Schema 无效' }];
  }
  return [];
}

/**
 * 校验包含输入输出 Schema 的公共契约。
 *
 * @param name - 公共契约名称
 * @param input - 已通过外层结构校验的输入
 * @returns 嵌入 Schema 的字段级问题列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateContractSchemas(name: ContractName, input: unknown): ContractIssue[] {
  // 只有声明嵌入 Schema 的契约需要额外检查。
  if (!isRecord(input) || !['function', 'pluginManifest'].includes(name)) {
    return [];
  }
  return [
    ...validateEmbeddedSchema(input.inputSchema, 'inputSchema'),
    ...validateEmbeddedSchema(input.outputSchema, 'outputSchema')
  ];
}

/**
 * 校验插件 API 版本并返回版本错误。
 *
 * @param input - 待检查的未知输入
 * @returns 版本错误或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateApiVersion(input: unknown): ContractErrorResult | undefined {
  // 非对象属于普通契约结构错误，而不是版本不兼容。
  if (!isRecord(input)) {
    return validationError([{ path: '/', keyword: 'type', message: '契约必须是对象' }]);
  }
  // 缺失版本字段必须与已声明的旧版本区分。
  if (!Object.hasOwn(input, 'apiVersion')) {
    return validationError([{ path: '/apiVersion', keyword: 'required', message: '缺少 API 版本' }]);
  }
  // 已声明但不支持的版本才映射为兼容性错误。
  if (input.apiVersion !== IAR_API_VERSION) {
    return validationError([{ path: '/apiVersion', keyword: 'const', message: 'API 版本不兼容' }], ERROR_CODES.INCOMPATIBLE_API_VERSION);
  }
  return undefined;
}

/**
 * 校验 PluginManifest 及其嵌入的输入输出 Schema。
 *
 * @param input - 待校验的未知 Manifest
 * @returns 强类型 Manifest 或稳定错误结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function validatePluginManifest(input: unknown): ValidationResult<PluginManifest> {
  const versionError = validateApiVersion(input);
  if (versionError) {
    return { ok: false, error: versionError };
  }
  const result = validateContract('pluginManifest', input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, value: result.value as PluginManifest };
}

/**
 * 校验并返回 PluginManifest，失败时抛出稳定的契约异常。
 *
 * @param input - 待校验的未知 Manifest
 * @returns 通过校验的强类型 Manifest
 * @throws {ContractValidationError} 当 Manifest 不满足公共契约时抛出
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function parsePluginManifest(input: unknown): PluginManifest {
  const result = validatePluginManifest(input);
  if (!result.ok) {
    const details = result.error.details?.issues;
    const issues = Array.isArray(details) ? details as ContractIssue[] : [];
    throw new ContractValidationError(result.error.message, issues, result.error.code);
  }
  return result.value;
}
