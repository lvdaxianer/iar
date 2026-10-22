/**
 * 定义 Function Calling 的工具描述、提案契约和严格边界校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
import type { JsonValue } from '@iar/contracts';
import type { ModelOutputValidation } from './types.js';

/** 交给 Function-call 模型的已安装工具快照。 */
export type FunctionToolDefinition = {
  /** OpenAI-compatible tool name。 */
  name: string;
  /** 所属 Plugin 标识。 */
  pluginId: string;
  /** 已安装 Function 标识。 */
  functionId: string;
  /** 面向模型的有限说明。 */
  description: string;
  /** 已安装 Function 的输入 JSON Schema。 */
  parameters: JsonValue;
  /** 可选的已安装默认操作。 */
  operation?: string;
};

/** Function Calling 的唯一公共输出契约。 */
export type FunctionCallProposal = {
  /** Function-call schema 版本。 */
  schemaVersion: 'iar.function-call/v1';
  /** 经过 Runtime 重新校验的 Plugin 标识。 */
  pluginId: string;
  /** 经过 Runtime 重新校验的 Function 标识。 */
  functionId: string;
  /** 请求执行的已声明操作。 */
  operation: string;
  /** 仅由安装记录的 inputSchema 校验后的参数。 */
  arguments: Record<string, JsonValue>;
  /** 模型对工具选择的有限置信度。 */
  confidence: number;
};

/** Nested Plugin tool 的 Function/Operation 运行时候选摘要。 */
export type NestedFunctionCandidateDefinition = {
  pluginId: string;
  functionId: string;
  operations: readonly { name: string }[];
};

/** 一个 Plugin 一个 OpenAI tool 的传输定义，candidates 仅用于运行时归属校验。 */
export type NestedFunctionToolDefinition = {
  name: string;
  pluginId: string;
  description: string;
  parameters: JsonValue;
  candidates: readonly NestedFunctionCandidateDefinition[];
};

/** Nested tool call 的版本化模型提案。 */
export type NestedFunctionCallProposal = {
  schemaVersion: 'iar.nested-function-call/v1';
  pluginId: string;
  toolName: string;
  functionId: string;
  operation: string;
  arguments: Record<string, JsonValue>;
  confidence: number;
};

/**
 * 校验模型 Function-call 提案，并将工具身份限制在已安装快照内。
 * @param raw - provider 原始输出
 * @param tools - 当前选定 Plugin 暴露的工具集合
 * @returns 经过边界校验的 Function-call 提案
 * @author lvdaxianer@yeah.net
 * @date 2026-10-22
 */
export function validateFunctionCallProposal(raw: unknown, tools: readonly FunctionToolDefinition[] = []): ModelOutputValidation<FunctionCallProposal> {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'pluginId', 'functionId', 'operation', 'arguments', 'confidence'])) return invalid('Function-call Schema 无效');
  if (raw.schemaVersion !== 'iar.function-call/v1' || !isNonEmptyString(raw.pluginId) || !isNonEmptyString(raw.functionId) || !isNonEmptyString(raw.operation) || !isArguments(raw.arguments) || !isConfidence(raw.confidence)) return invalid('Function-call Schema 无效');
  const functionTool = tools.find((item) => item.pluginId === raw.pluginId && item.functionId === raw.functionId);
  const tool = tools.find((item) => item.pluginId === raw.pluginId && item.functionId === raw.functionId && (item.operation === undefined || item.operation === raw.operation));
  if (tools.length > 0 && !functionTool) return invalid('Function-call 工具不在当前 Plugin 范围内');
  if (tools.length > 0 && !tool) return invalid('Function-call operation 不匹配已安装工具');
  return { ok: true, value: structuredClone(raw) as FunctionCallProposal };
}

/** 校验 nested Plugin tool call，并限制 Function/Operation 归属。 */
export function validateNestedFunctionCallProposal(raw: unknown, tools: readonly NestedFunctionToolDefinition[] = []): ModelOutputValidation<NestedFunctionCallProposal> {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'pluginId', 'toolName', 'functionId', 'operation', 'arguments', 'confidence'])) return invalidNested('Nested Function-call Schema 无效');
  if (raw.schemaVersion !== 'iar.nested-function-call/v1' || !isNonEmptyString(raw.pluginId) || !isNonEmptyString(raw.toolName) || !isNonEmptyString(raw.functionId) || !isNonEmptyString(raw.operation) || !isArguments(raw.arguments) || !isConfidence(raw.confidence)) return invalidNested('Nested Function-call Schema 无效');
  const tool = tools.find((item) => item.name === raw.toolName);
  if (!tool || tool.pluginId !== raw.pluginId) return invalidNested('Nested tool 不在当前 Plugin 范围内');
  if (new Set(tool.candidates.map((item) => `${item.pluginId}\u0000${item.functionId}`)).size !== tool.candidates.length) return invalidNested('Nested tool 的 Function 标识必须唯一');
  const candidate = tool.candidates.find((item) => item.pluginId === raw.pluginId && item.functionId === raw.functionId);
  if (!candidate || !candidate.operations.some((operation) => operation.name === raw.operation)) return invalidNested('Nested Function/Operation 不属于当前 Plugin tool');
  return { ok: true, value: structuredClone(raw) as NestedFunctionCallProposal };
}

/** 创建统一的边界失败结果。 */
function invalid(message: string): ModelOutputValidation<FunctionCallProposal> {
  return { ok: false, message };
}

/** 创建 nested Function-call 的稳定失败结果。 */
function invalidNested(message: string): ModelOutputValidation<NestedFunctionCallProposal> {
  return { ok: false, message };
}

/** 判断 Function 参数是否为 JSON-safe 的普通对象。 */
function isArguments(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

/** 判断普通对象是否只包含固定字段。 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** 判断有限置信度。 */
function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** 判断非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 判断 JSON-safe 值。 */
function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? value.every((item) => isJsonValue(item, seen)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

/** 判断 JSON-safe 普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
