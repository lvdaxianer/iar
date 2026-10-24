/**
 * 提供 agent sandbox 十个 Function 插件共享的辅助类型与工具。
 *
 * 统一 Handler 输入形状为 { operation?: string, query?: string, params?: Record<string,string> }：
 * operation 缺省时由各 Handler 按 query 关键词在 read 操作内推断默认值；
 * params 只接受字符串值的映射，任何未知字段、类型不符或越界都会被 fail-closed 拒绝。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { MAX_TRUSTED_FACTS, MAX_TRUSTED_FACT_KEY_LENGTH, MAX_TRUSTED_FACT_STRING_LENGTH, SCHEMA_VERSIONS, TRUSTED_FACT_KEY_PATTERN, type BusinessPluginManifest, type FunctionDefinition, type JsonValue, type PluginOperation } from '@iar/contracts';
import { definePlugin, type FunctionHandler, type FunctionHandlerResult, type PluginPackage } from '@iar/plugin';

/** Function 操作类型：read 免确认直接执行，action 需走确认流。 */
export type SandboxOperationKind = 'read' | 'action';

/** Function 单个操作的显式声明，供 session 判定确认策略与提示词描述能力。 */
export type SandboxOperation = {
  /** 操作名，作为 Handler 的 operation 入参。 */
  name: string;
  /** 操作类型。 */
  kind: SandboxOperationKind;
  /** 操作的中文能力描述。 */
  description: string;
};

/** 由包级 Manifest、Function 定义和 Handler 组装统一 Plugin 包。 */
export function defineSandboxPlugin(manifest: BusinessPluginManifest, definition: FunctionDefinition, operations: readonly PluginOperation[], handler: FunctionHandler): PluginPackage {
  return definePlugin({ manifest, functions: [{ definition, operations, handler }] });
}

/** 校验通过的统一 Handler 输入。 */
export type SandboxParsedInput = {
  /** 请求的操作名，缺省时由 Handler 推断默认 read 操作。 */
  operation: string | undefined;
  /** 自由文本查询或问题描述。 */
  query: string;
  /** 字符串键值参数。 */
  params: Record<string, string>;
};

/** operation 字段长度上限。 */
const MAX_OPERATION_LENGTH = 60;

/** query 字段长度上限。 */
const MAX_QUERY_LENGTH = 500;

/** 单个 param 值的长度上限。 */
const MAX_PARAM_VALUE_LENGTH = 200;

/** 单个 param 名的长度上限。 */
const MAX_PARAM_KEY_LENGTH = 60;

/**
 * 以 fail-closed 方式解析统一 Handler 输入。
 *
 * @param input - SDK 传入的 JSON 输入
 * @returns 解析后的输入，非法输入返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function parseSandboxInput(input: JsonValue): SandboxParsedInput | undefined {
  try {
    // 非对象、数组或携带未知字段的输入必须在读取字段前拒绝。
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
    if (Object.keys(input).some((key) => !['operation', 'query', 'params'].includes(key))) return undefined;
    const record = input as Record<string, unknown>;
    const operation = record.operation;
    const query = record.query;
    const params = record.params;
    if (operation !== undefined && (typeof operation !== 'string' || operation.trim().length === 0 || operation.length > MAX_OPERATION_LENGTH)) return undefined;
    if (query !== undefined && (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH)) return undefined;
    const parsedParams: Record<string, string> = {};
    if (params !== undefined) {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined;
      for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
        if (key.length > MAX_PARAM_KEY_LENGTH || typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_PARAM_VALUE_LENGTH) return undefined;
        parsedParams[key] = value.trim();
      }
    }
    return {
      operation: typeof operation === 'string' ? operation.trim() : undefined,
      query: typeof query === 'string' ? query : '',
      params: parsedParams
    };
  } catch {
    // 运行时 getter、Proxy 或结构异常统一按非法输入 fail-closed。
    return undefined;
  }
}

/**
 * 在操作目录中按名称查找操作。
 *
 * @param operations - Function 的显式操作目录
 * @param name - 操作名
 * @returns 匹配的操作或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function findSandboxOperation(operations: readonly SandboxOperation[], name: string): SandboxOperation | undefined {
  return operations.find((operation) => operation.name === name);
}

/**
 * 构造执行成功的 Handler 结果，输出统一携带 accepted 与 operation 标识。
 *
 * @param operation - 实际执行的操作名
 * @param payload - 操作相关的确定性结果字段
 * @returns 成功的 FunctionHandlerResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function succeed(operation: string, payload: Record<string, JsonValue>, declaredFacts: Record<string, JsonValue> = {}, declaredFactRecords: readonly Record<string, JsonValue>[] = []): FunctionHandlerResult {
  const facts = selectTrustedFacts(declaredFacts);
  const factRecords = declaredFactRecords.map((values) => ({ values: selectTrustedFacts(values) })).filter((record) => Object.keys(record.values).length > 0);
  return { status: 'succeeded', output: { accepted: true, operation, ...payload, facts, ...(factRecords.length > 0 ? { factRecords } : {}) }, response: { schemaVersion: SCHEMA_VERSIONS.functionResponse, mode: 'model' } };
}

/** 只把短小 JSON 原子字段复制到通用事实信封。 */
function isBoundedFactValue(value: JsonValue): boolean {
  return (typeof value === 'string' && Array.from(value).length <= MAX_TRUSTED_FACT_STRING_LENGTH) || typeof value === 'number' || typeof value === 'boolean' || value === null;
}

/** 仅复制 Handler 明确公开的有限字段，避免把完整业务对象带入上下文。 */
function selectTrustedFacts(values: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(values).filter(([field, value]) => isTrustedFactKey(field) && isBoundedFactValue(value)).slice(0, MAX_TRUSTED_FACTS));
}

/** 事实键只能是稳定标识，核心不解释业务语义。 */
function isTrustedFactKey(value: string): boolean {
  return value.length <= MAX_TRUSTED_FACT_KEY_LENGTH && new RegExp(TRUSTED_FACT_KEY_PATTERN).test(value);
}

/**
 * 构造业务拒绝的 Handler 结果，输出统一携带 accepted:false 与稳定 errorCode。
 *
 * @param errorCode - 稳定错误码
 * @returns 失败的 FunctionHandlerResult
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function fail(errorCode: string): FunctionHandlerResult {
  return { status: 'failed', output: { accepted: false, errorCode }, errorCode, response: { schemaVersion: SCHEMA_VERSIONS.functionResponse, mode: 'model' } };
}

/**
 * 十个 Function 插件共享的统一输入 JSON Schema。
 *
 * @returns 统一 inputSchema 对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function sandboxInputSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      operation: { type: 'string', minLength: 1, maxLength: MAX_OPERATION_LENGTH },
      query: { type: 'string', maxLength: MAX_QUERY_LENGTH },
      params: { type: 'object', additionalProperties: { type: 'string' } }
    },
    additionalProperties: false
  };
}

/**
 * 十个 Function 插件共享的统一输出 JSON Schema 信封。
 *
 * 成功输出固定携带 accepted:true 与 operation，业务字段放开 additionalProperties；
 * 拒绝输出固定携带 accepted:false 与稳定 errorCode。
 *
 * @returns 统一 outputSchema 对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function sandboxOutputSchema(): Record<string, unknown> {
  const factValue = { anyOf: [{ type: 'string', maxLength: MAX_TRUSTED_FACT_STRING_LENGTH }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
  const facts = { type: 'object', maxProperties: MAX_TRUSTED_FACTS, propertyNames: { pattern: TRUSTED_FACT_KEY_PATTERN, maxLength: MAX_TRUSTED_FACT_KEY_LENGTH }, additionalProperties: factValue };
  const factRecords = { type: 'array', maxItems: MAX_TRUSTED_FACTS, items: { type: 'object', properties: { values: facts }, required: ['values'], additionalProperties: false } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    oneOf: [
      {
        type: 'object',
        properties: { accepted: { const: true }, operation: { type: 'string', minLength: 1 }, facts, factRecords },
        required: ['accepted', 'operation'],
        additionalProperties: true
      },
      {
        type: 'object',
        properties: { accepted: { const: false }, errorCode: { type: 'string', minLength: 1 } },
        required: ['accepted', 'errorCode'],
        additionalProperties: true
      }
    ]
  };
}
