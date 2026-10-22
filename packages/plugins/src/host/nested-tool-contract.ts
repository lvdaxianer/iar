/**
 * 定义 Plugin 边界下的 OpenAI-compatible 嵌套工具契约。
 *
 * 该模块只负责安全的结构校验和稳定名称映射，不授予任何执行权限。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
import type { ActionType, ContractIssue, JsonSchema, JsonValue, PluginOperation, RiskLevel } from '@iar/contracts';

/** OpenAI-compatible 工具名称的字符约束。 */
export const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** OpenAI-compatible 工具名称的最大长度。 */
export const MAX_OPENAI_TOOL_NAME_LENGTH = 64;

/** 工具描述的最大长度，避免 Plugin 元数据无界膨胀模型请求。 */
export const MAX_NESTED_TOOL_DESCRIPTION_LENGTH = 1024;

/** 嵌套工具标识字段的最大长度。 */
export const MAX_NESTED_IDENTIFIER_LENGTH = 320;

/** 置信度允许的最小值。 */
export const MIN_NESTED_CONFIDENCE = 0;

/** 置信度允许的最大值。 */
export const MAX_NESTED_CONFIDENCE = 1;

/** OpenAI-compatible Schema 的保守类型子集。 */
const SUPPORTED_JSON_SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);

/** OpenAI-compatible Schema 的保守关键字子集。 */
const SUPPORTED_JSON_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'enum', 'additionalProperties', 'description', 'items']);

/** 嵌套 Function Calling 提案的稳定版本。 */
export const NESTED_FUNCTION_CALL_SCHEMA_VERSION = 'iar.nested-function-call/v1' as const;

/** 传给模型的 Plugin 工具外壳。 */
export type NestedPluginTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

/** Plugin 工具内部的 Function 候选，保留运行时所有权和输入边界。 */
export type NestedPluginFunctionCandidate = {
  pluginId: string;
  functionId: string;
  description: string;
  actionTypes: ActionType[];
  inputSchema: JsonSchema;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  operations: PluginOperation[];
};

/** 模型工具与宿主侧候选映射的绑定快照。 */
export type NestedPluginToolBinding = {
  pluginId: string;
  toolName: string;
  tool: NestedPluginTool;
  candidates: NestedPluginFunctionCandidate[];
};

/** 解析后的嵌套 Function Calling 提案。 */
export type NestedFunctionCallProposal = {
  schemaVersion: typeof NESTED_FUNCTION_CALL_SCHEMA_VERSION;
  pluginId: string;
  toolName: string;
  functionId: string;
  operation: string;
  arguments: Record<string, JsonValue>;
  confidence: number;
};

/** 供模型提案适配器使用的未知输入类型。 */
export type NestedFunctionCallInput = {
  schemaVersion?: unknown;
  pluginId?: unknown;
  toolName?: unknown;
  functionId?: unknown;
  operation?: unknown;
  arguments?: unknown;
  confidence?: unknown;
};

/** 纯契约校验结果，失败时只返回字段级问题，不执行任何副作用。 */
export type NestedContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractIssue[] };

/**
 * 将 Plugin 标识映射为稳定且符合 OpenAI 字符限制的工具名。
 *
 * @param pluginId - 原始 Plugin 标识
 * @returns 可传给模型的稳定工具名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function normalizePluginToolName(pluginId: string): string {
  const normalized = [...pluginId]
    .map((character) => /^[a-zA-Z0-9_-]$/.test(character) ? character : `_u${character.codePointAt(0)?.toString(16) ?? '0'}_`)
    .join('')
    .replace(/^_+|_+$/g, '');
  const base = normalized.length > 0 ? normalized : 'unnamed';
  return `plugin_${base}`.slice(0, MAX_OPENAI_TOOL_NAME_LENGTH);
}

/**
 * 校验一个 Plugin 工具是否符合模型传输边界和保守 JSON Schema 子集。
 *
 * @param tool - 待校验的 Plugin 工具
 * @returns 合法工具或字段级问题
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function validateNestedPluginTool(tool: unknown): NestedContractResult<NestedPluginTool> {
  const issues: ContractIssue[] = [];
  if (!isRecord(tool) || !isRecord(tool.function)) {
    return { ok: false, issues: [issue('/', 'type', 'Plugin 工具必须是合法对象')] };
  }
  validateToolEnvelope(tool, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: structuredClone(tool) as NestedPluginTool };
}

/**
 * 将未知模型输出解析为版本化嵌套 Function Calling 提案。
 *
 * @param input - 模型返回的未知提案对象
 * @returns 结构化提案或字段级问题
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function createNestedFunctionCallProposal(input: NestedFunctionCallInput): NestedContractResult<NestedFunctionCallProposal> {
  const issues: ContractIssue[] = [];
  validateProposalFields(input, issues);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: NESTED_FUNCTION_CALL_SCHEMA_VERSION,
      pluginId: input.pluginId as string,
      toolName: input.toolName as string,
      functionId: input.functionId as string,
      operation: input.operation as string,
      arguments: structuredClone(input.arguments) as Record<string, JsonValue>,
      confidence: input.confidence as number
    }
  };
}

/**
 * 校验工具外壳和参数 Schema。
 *
 * @param tool - 待校验的工具
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateToolEnvelope(tool: Record<string, unknown>, issues: ContractIssue[]): void {
  const functionValue = tool.function;
  if (!isRecord(functionValue)) return;
  if (tool.type !== 'function') issues.push(issue('/type', 'const', '工具类型必须是 function'));
  if (!isValidToolName(functionValue.name)) issues.push(issue('/function/name', 'pattern', '工具名必须符合 OpenAI 字符和长度限制'));
  if (!isBoundedString(functionValue.description, MAX_NESTED_TOOL_DESCRIPTION_LENGTH)) issues.push(issue('/function/description', 'maxLength', '工具描述不能为空且不能超过长度上限'));
  validateJsonSchema(functionValue.parameters, '/function/parameters', issues);
}

/**
 * 校验嵌套提案的标识、参数对象和置信度。
 *
 * @param input - 待校验的提案
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateProposalFields(input: NestedFunctionCallInput, issues: ContractIssue[]): void {
  if (input.schemaVersion !== NESTED_FUNCTION_CALL_SCHEMA_VERSION) issues.push(issue('/schemaVersion', 'const', '嵌套提案版本不支持'));
  validateRequiredString(input.pluginId, '/pluginId', issues);
  validateRequiredString(input.toolName, '/toolName', issues);
  if (typeof input.toolName === 'string' && !isValidToolName(input.toolName)) issues.push(issue('/toolName', 'pattern', '工具名必须符合 OpenAI 字符和长度限制'));
  validateRequiredString(input.functionId, '/functionId', issues);
  validateRequiredString(input.operation, '/operation', issues);
  if (!isJsonObject(input.arguments)) issues.push(issue('/arguments', 'type', 'Function 参数必须是 JSON 对象'));
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < MIN_NESTED_CONFIDENCE || input.confidence > MAX_NESTED_CONFIDENCE) issues.push(issue('/confidence', 'range', 'confidence 必须位于 0 到 1 之间'));
}

/**
 * 校验一个受支持的 JSON Schema 子集。
 *
 * @param schema - 待校验的 Schema
 * @param path - 当前字段路径
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateJsonSchema(schema: unknown, path: string, issues: ContractIssue[]): void {
  if (!isRecord(schema)) {
    issues.push(issue(path, 'type', 'parameters 必须是 JSON Schema 对象'));
    return;
  }
  const unknownKey = Object.keys(schema).find((key) => !SUPPORTED_JSON_SCHEMA_KEYS.has(key));
  if (unknownKey) issues.push(issue(`${path}/${unknownKey}`, 'additionalProperties', 'Schema 关键字不在受支持子集内'));
  if (typeof schema.type !== 'string' || !SUPPORTED_JSON_SCHEMA_TYPES.has(schema.type)) issues.push(issue(`${path}/type`, 'enum', 'Schema type 不受支持'));
  if (schema.description !== undefined && !isBoundedString(schema.description, MAX_NESTED_TOOL_DESCRIPTION_LENGTH)) issues.push(issue(`${path}/description`, 'maxLength', 'Schema description 超过长度上限'));
  validateSchemaProperties(schema.properties, path, issues);
  validateRequired(schema.required, path, issues);
  validateEnum(schema.enum, path, issues);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') issues.push(issue(`${path}/additionalProperties`, 'type', 'additionalProperties 必须是布尔值'));
  if (schema.items !== undefined && isRecord(schema.items)) validateJsonSchema(schema.items, `${path}/items`, issues);
}

/**
 * 校验 Schema 的 properties 子对象。
 *
 * @param properties - 待校验的属性映射
 * @param path - 当前字段路径
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateSchemaProperties(properties: unknown, path: string, issues: ContractIssue[]): void {
  if (properties === undefined) return;
  if (!isRecord(properties)) {
    issues.push(issue(`${path}/properties`, 'type', 'properties 必须是对象'));
    return;
  }
  Object.entries(properties).forEach(([key, value]) => {
    if (isRecord(value)) validateJsonSchema(value, `${path}/properties/${key}`, issues);
    else issues.push(issue(`${path}/properties/${key}`, 'type', '属性 Schema 必须是对象'));
  });
}

/**
 * 校验 Schema 的 required 子数组。
 *
 * @param required - 待校验的必填字段列表
 * @param path - 当前字段路径
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateRequired(required: unknown, path: string, issues: ContractIssue[]): void {
  if (required === undefined) return;
  if (!Array.isArray(required) || required.some((item) => typeof item !== 'string')) issues.push(issue(`${path}/required`, 'type', 'required 必须是字符串数组'));
}

/**
 * 校验 Schema 的 enum 子数组。
 *
 * @param values - 待校验的枚举值
 * @param path - 当前字段路径
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateEnum(values: unknown, path: string, issues: ContractIssue[]): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.some((value) => !isJsonValue(value))) issues.push(issue(`${path}/enum`, 'type', 'enum 必须是 JSON 值数组'));
}

/**
 * 判断值是否为对象且不为数组。
 *
 * @param value - 待判断值
 * @returns 是否为 JSON 对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

/**
 * 判断值是否为 JSON 值。
 *
 * @param value - 待判断值
 * @returns 是否为 JSON 值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

/**
 * 判断一个值是否为普通对象。
 *
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断字符串是否非空且不超过上限。
 *
 * @param value - 待判断值
 * @param maxLength - 最大长度
 * @returns 是否满足长度边界
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/**
 * 判断工具名称是否满足 OpenAI 兼容限制。
 *
 * @param value - 待判断工具名
 * @returns 是否为合法工具名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function isValidToolName(value: unknown): value is string {
  return isBoundedString(value, MAX_OPENAI_TOOL_NAME_LENGTH) && OPENAI_TOOL_NAME_PATTERN.test(value);
}

/**
 * 校验必填字符串字段。
 *
 * @param value - 待校验值
 * @param path - 字段路径
 * @param issues - 收集校验问题的数组
 * @returns 无返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function validateRequiredString(value: unknown, path: string, issues: ContractIssue[]): void {
  if (!isBoundedString(value, MAX_NESTED_IDENTIFIER_LENGTH)) issues.push(issue(path, 'type', '字段必须是非空字符串且不能超过长度上限'));
}

/**
 * 创建字段级契约问题。
 *
 * @param path - 字段路径
 * @param keyword - 触发的校验关键字
 * @param message - 面向开发者的稳定说明
 * @returns 契约问题
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
function issue(path: string, keyword: string, message: string): ContractIssue {
  return { path, keyword, message };
}
