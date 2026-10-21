/**
 * 提供公共契约的运行时校验和稳定错误转换。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MAX_FUNCTION_RESPONSE_UI_BYTES } from './schema-function-response.js';
import { ContractValidationError, ERROR_CODES, type ContractErrorResult, type ContractIssue, type ErrorCode } from './errors.js';
import { CompactionEventPayloadSchema, CompactionFailedEventPayloadSchema } from './schema-compaction.js';
import { CONTRACT_SCHEMAS } from './schemas.js';
import type { FunctionResponse, JsonSchema, JsonValue, PluginManifest } from './types.js';
import { IAR_API_VERSION, SCHEMA_VERSIONS } from './versions.js';

/** 表示校验成功或失败的显式结果，避免以 null 表示失败。 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorResult };

/** 按 Schema 对象身份缓存编译结果，避免每次 Function 调用重复创建 Ajv。 */
const JSON_SCHEMA_VALIDATORS = new WeakMap<object, ValidateFunction>();

/** 表示公开的契约 Schema 名称。 */
export type ContractName = keyof typeof CONTRACT_SCHEMAS;

/** 使用同一 Ajv 实例编译所有内部契约 Schema。 */
const contractAjv = new Ajv2020({ allErrors: true, strict: false });

/** 缓存编译后的公共 Schema，避免每次验证重复编译。 */
const validators = Object.fromEntries(
  Object.entries(CONTRACT_SCHEMAS).map(([name, schema]) => [name, contractAjv.compile(schema)])
) as Record<ContractName, ValidateFunction<unknown>>;

/** 上下文压缩事件的专用载荷校验器。 */
const eventPayloadValidators = {
  'context.compacted': contractAjv.compile(CompactionEventPayloadSchema),
  'context.compaction_failed': contractAjv.compile(CompactionFailedEventPayloadSchema)
} as const;

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
  const responseIssues = responseSemanticIssues(name, input);
  if (responseIssues.length > 0) return { ok: false, error: validationError(responseIssues) };
  const issues = validateContractSchemas(name, input);
  // 嵌入 Schema 错误使用独立错误码，便于安装路径处理。
  if (issues.length > 0) return { ok: false, error: validationError(issues, ERROR_CODES.INVALID_EMBEDDED_SCHEMA) };
  const eventIssues = name === 'event' ? validateEventPayload(input) : [];
  if (eventIssues.length > 0) return { ok: false, error: validationError(eventIssues) };
  const relationIssues = validateRelationIssues(name, input);
  // 跨字段关系失败时拒绝 Manifest，但保留字段级诊断。
  if (relationIssues.length > 0) return { ok: false, error: validationError(relationIssues) };
  return { ok: true, value: input };
}

/** 校验固定回复中的递归 JSON 数据和资源边界。 */
function responseSemanticIssues(name: ContractName, input: unknown): ContractIssue[] {
  const response = name === 'functionResponse' ? input : isRecord(input) && input.response !== undefined ? input.response : undefined;
  if (response === undefined) return [];
  if (!isRecord(response) || (response.ui !== undefined && !isJsonValue(response.ui))) return [{ path: '/response/ui', keyword: 'type', message: 'UI 数据必须是 JSON 值' }];
  return response.ui !== undefined && jsonBytes(response.ui) > MAX_FUNCTION_RESPONSE_UI_BYTES
    ? [{ path: '/response/ui', keyword: 'maxBytes', message: 'UI 数据超过大小上限' }]
    : [];
}

/** 按事件名称校验上下文压缩事件的专用载荷。 */
function validateEventPayload(input: unknown): ContractIssue[] {
  if (!isRecord(input) || typeof input.eventName !== 'string') return [];
  const validator = eventPayloadValidators[input.eventName as keyof typeof eventPayloadValidators];
  if (!validator || validator(input.payload)) return [];
  return toIssues(validator.errors);
}

/** 按契约类型校验需要跨字段判断的结构化关系。 */
function validateRelationIssues(name: ContractName, input: unknown): ContractIssue[] {
  if (name === 'pluginManifest') return validatePluginManifestRelations(input);
  if (name === 'behaviorContext') return validateBehaviorContextRelations(input);
  return [];
}

/** 拒绝 pending 选项中复用同一不透明键的歧义数据。 */
function validateBehaviorContextRelations(input: unknown): ContractIssue[] {
  if (!isRecord(input)) return [];
  const issues = validatePendingOptionKeys(input);
  if (isRecord(input.factHistory)) issues.push(...validateFactHistoryRelations(input.factHistory));
  return issues;
}

/** 校验 pending 选项的动态键唯一性。 */
function validatePendingOptionKeys(input: Record<string, unknown>): ContractIssue[] {
  if (!isRecord(input.pending) || !Array.isArray(input.pending.options)) return [];
  const keys = input.pending.options.map((option) => isRecord(option) && typeof option.key === 'string' ? option.key : undefined);
  const validKeys = keys.filter((key): key is string => key !== undefined);
  return new Set(validKeys).size === validKeys.length ? [] : [{ path: '/pending/options', keyword: 'uniqueKeys', message: '澄清选项键必须唯一' }];
}

/** 校验事实链中的 ID、焦点和严格递增顺序。 */
function validateFactHistoryRelations(history: Record<string, unknown>): ContractIssue[] {
  if (!Array.isArray(history.records)) return [];
  const records = history.records.filter(isRecord);
  const issues: ContractIssue[] = [];
  const ids = records.map((record) => record.recordId).filter((id): id is string => typeof id === 'string');
  if (new Set(ids).size !== ids.length) issues.push({ path: '/factHistory/records', keyword: 'uniqueRecordIds', message: '事实记录 ID 必须唯一' });
  if (typeof history.focusRecordId === 'string' && !ids.includes(history.focusRecordId)) issues.push({ path: '/factHistory/focusRecordId', keyword: 'reference', message: '事实焦点必须指向已有记录' });
  const sequences = records.map((record) => record.sequence).filter((sequence): sequence is number => typeof sequence === 'number');
  if (sequences.some((sequence, index) => {
    const previous = sequences[index - 1];
    return index > 0 && previous !== undefined && sequence <= previous;
  })) issues.push({ path: '/factHistory/records', keyword: 'ordered', message: '事实记录必须按 sequence 升序排列' });
  return issues;
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
    compileJsonSchema(value);
  } catch {
    // 未知 $schema 引用等 Ajv 异常也转换成稳定错误，而不向上泄漏实现异常。
    return [{ path: `/${field}`, keyword: 'schema', message: '嵌入的 JSON Schema 无效' }];
  }
  return [];
}

/** 编译并验证一个 Plugin 声明的 JSON Schema 数据值。 */
export function validateJsonSchemaValue(schema: JsonSchema, value: unknown): ValidationResult<JsonValue> {
  try {
    const validator = compileJsonSchema(schema);
    if (!validator(value)) return { ok: false, error: validationError(toIssues(validator.errors)) };
    return { ok: true, value: structuredClone(value) as JsonValue };
  } catch {
    return { ok: false, error: validationError([{ path: '/', keyword: 'schema', message: 'JSON Schema 无法编译' }], ERROR_CODES.INVALID_EMBEDDED_SCHEMA) };
  }
}

/** 编译并缓存一个 JSON Schema，调用方只负责处理其校验结果。 */
function compileJsonSchema(schema: JsonSchema): ValidateFunction {
  const cached = JSON_SCHEMA_VALIDATORS.get(schema);
  if (cached) return cached;
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  JSON_SCHEMA_VALIDATORS.set(schema, validator);
  return validator;
}

/** 验证 Function 的固定回复信封。 */
export function validateFunctionResponse(input: unknown): ValidationResult<FunctionResponse> {
  const result = validateContract('functionResponse', input);
  if (!result.ok) return { ok: false, error: result.error };
  if (!isRecord(input) || !['direct', 'model', 'none'].includes(String(input.mode)) || input.ui !== undefined && !isJsonValue(input.ui)) return { ok: false, error: validationError([{ path: '/mode', keyword: 'enum', message: '回复模式或 UI 数据无效' }]) };
  if (input.ui !== undefined && jsonBytes(input.ui) > MAX_FUNCTION_RESPONSE_UI_BYTES) return { ok: false, error: validationError([{ path: '/ui', keyword: 'maxBytes', message: 'UI 数据超过大小上限' }]) };
  return { ok: true, value: structuredClone(result.value) as FunctionResponse };
}

/** 判断值是否为可安全进入 Function 响应信封的 JSON 值。 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/** 验证 Function Handler 的固定输出外壳。 */
export function validateFunctionHandlerResult(input: unknown): ValidationResult<{ output: JsonValue; status: 'succeeded' | 'failed'; errorCode?: string; response: FunctionResponse }> {
  const result = validateContract('functionResult', input);
  if (!result.ok) return { ok: false, error: result.error };
  const raw = result.value as { output?: unknown; status?: unknown; errorCode?: string; response?: unknown };
  if (!isJsonValue(raw.output)) return { ok: false, error: validationError([{ path: '/output', keyword: 'type', message: 'Function 输出必须是 JSON 值' }]) };
  const value = raw as { output: JsonValue; status: 'succeeded' | 'failed'; errorCode?: string; response: FunctionResponse };
  const response = validateFunctionResponse(value.response);
  if (!response.ok) return response;
  return { ok: true, value: { ...structuredClone(value), response: response.value } };
}

/** 计算 JSON 值的 UTF-8 大小，异常值按无穷大处理。 */
function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
  if (!isRecord(input) || name === 'function') {
    return name === 'function' && isRecord(input)
      ? [
        ...validateEmbeddedSchema(input.inputSchema, 'inputSchema'),
        ...validateEmbeddedSchema(input.outputSchema, 'outputSchema')
      ]
      : [];
  }
  // 业务 Plugin 的 Schema 归属于其嵌套 Function，系统 Plugin 仍保留自己的边界。
  if (name !== 'pluginManifest' || input.pluginKind !== 'system') {
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
