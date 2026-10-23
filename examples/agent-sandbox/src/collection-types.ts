import { validateJsonSchemaValue, type JsonSchema, type JsonValue } from '@iar/contracts';

/** Function 参数收集器向日志、页面和澄清层公开的字段摘要。 */
export type ParameterValidationSummary = {
  expectedFields: string[];
  presentFields: string[];
  missingFields: string[];
  invalidFields: string[];
  conflictFields: string[];
  valid: boolean;
};

/**
 * 根据已注册 Function 的 JSON Schema 汇总参数边界。
 * 该函数只读取 Schema 结构，不读取业务关键词，也不尝试推断字段值。
 *
 * @param schema - 已通过安装校验的 Function 输入 Schema
 * @param value - 当前收集到的参数对象
 * @param conflictFields - 合并层检测出的冲突字段
 * @returns 有界字段级校验摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function summarizeParameterValidation(schema: JsonSchema, value: unknown, conflictFields: readonly string[] = [], runtimeRequiredFields: readonly string[] = []): ParameterValidationSummary {
  const record = isRecord(value) ? value : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const expectedFields = [...new Set([...Object.keys(properties), ...runtimeRequiredFields.filter((field) => typeof field === 'string' && field.trim().length > 0)])];
  const presentFields = Object.keys(record);
  const missingFields = expectedRequiredFields(schema, runtimeRequiredFields).filter((field) => !Object.hasOwn(record, field));
  const invalidFields = invalidFieldsFromSchema(schema, value, properties, presentFields, missingFields);
  const conflicts = uniqueFields(conflictFields);
  const orderedInvalidFields = orderFields(presentFields, invalidFields);
  return {
    expectedFields,
    presentFields,
    missingFields,
    invalidFields: orderedInvalidFields,
    conflictFields: conflicts,
    valid: validateJsonSchemaValue(schema, value).ok && missingFields.length === 0 && invalidFields.size === 0 && conflicts.length === 0
  };
}

/** 读取 Schema 的 required 字段，避免把业务语义带入收集判断。 */
function expectedRequiredFields(schema: JsonSchema, runtimeRequiredFields: readonly string[]): string[] {
  const schemaRequired = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : [];
  return [...new Set([...schemaRequired, ...runtimeRequiredFields.filter((field) => typeof field === 'string')])];
}

/** 根据 Schema 校验结果提取字段级错误。 */
function invalidFieldsFromSchema(schema: JsonSchema, value: unknown, properties: Record<string, unknown>, presentFields: string[], missingFields: string[]): Set<string> {
  const invalidFields = new Set<string>();
  if (schema.additionalProperties === false) for (const field of presentFields) if (!Object.hasOwn(properties, field)) invalidFields.add(field);
  const validation = validateJsonSchemaValue(schema, value);
  const issues = validation.ok ? [] : validation.error.details?.issues;
  if (Array.isArray(issues)) for (const issue of issues) {
    const field = topLevelIssueField(issue.path);
    if (field !== undefined && !missingFields.includes(field)) invalidFields.add(field);
  }
  return invalidFields;
}

/** 按用户输入顺序返回字段错误，保证澄清结果稳定可读。 */
function orderFields(presentFields: string[], fields: Set<string>): string[] {
  const ordered = presentFields.filter((field) => fields.has(field));
  for (const field of fields) if (!ordered.includes(field)) ordered.push(field);
  return ordered;
}

/** 从 Ajv 风格路径提取安全的顶层字段名。 */
function topLevelIssueField(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  const field = path.slice(1).split('/')[0] ?? '';
  return field.length > 0 ? field.replaceAll('~1', '/').replaceAll('~0', '~') : undefined;
}

function uniqueFields(fields: readonly string[]): string[] {
  return [...new Set(fields.filter((field) => field.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
