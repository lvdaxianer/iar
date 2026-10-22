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
  const tool = tools.find((item) => item.pluginId === raw.pluginId && item.functionId === raw.functionId);
  if (tools.length > 0 && !tool) return invalid('Function-call 工具不在当前 Plugin 范围内');
  if (tool?.operation && tool.operation !== raw.operation) return invalid('Function-call operation 不匹配已安装工具');
  return { ok: true, value: structuredClone(raw) as FunctionCallProposal };
}

/** 创建统一的边界失败结果。 */
function invalid(message: string): ModelOutputValidation<FunctionCallProposal> {
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
