import { MAX_CLARIFICATION_LABEL_LENGTH, MAX_CLARIFICATION_OPTIONS, MAX_COLLECTION_ATTEMPTS, MAX_COLLECTION_FIELD_LENGTH, MAX_COLLECTION_FIELDS, type CollectionState, type JsonSchema, type JsonValue } from '@iar/contracts';
import { summarizeParameterValidation, type ParameterValidationSummary } from './collection-types.js';

/** 参数收集器的结构化输入，值来源必须已经经过模型输出边界。 */
export type ParameterCollectionRequest = {
  functionId: string;
  pluginId?: string;
  schemaVersion: string;
  schema: JsonSchema;
  value: unknown;
  /** 运行时已经确定的额外必需字段，不改变 Function 的输入 Schema。 */
  requiredFields?: readonly string[];
  /** 上游结构化契约已经检测出的字段冲突。 */
  conflictFields?: readonly string[];
  previous?: Extract<CollectionState, { kind: 'parameters' }>;
  attempt: number;
};

/** 参数收集器的有限结果，不代表执行授权。 */
export type ParameterCollectionResult =
  | { status: 'ready'; input: Record<string, JsonValue> }
  | { status: 'collecting'; state: Extract<CollectionState, { kind: 'parameters' }>; summary: ParameterValidationSummary };

/**
 * 按 Function 输入 Schema 合并参数并决定是否继续收集。
 * 冲突字段保留当前轮值并阻断执行，未知或非法字段不会进入可执行参数。
 *
 * @param request - Function 标识、Schema、当前值和可恢复收集状态
 * @returns 完整输入或字段级收集状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
export function collectParameters(request: ParameterCollectionRequest): ParameterCollectionResult {
  const previous = sameCollection(request.previous, request);
  const incoming = toRecord(request.value);
  const merged = mergeValues(previous?.collected, incoming, previous?.conflictFields ?? []);
  const conflicts = [...new Set([
    ...(previous?.conflictFields ?? []).filter((field) => !Object.hasOwn(incoming, field)),
    ...merged.conflicts,
    ...(request.conflictFields ?? [])
  ])];
  const summary = summarizeParameterValidation(request.schema, merged.value, conflicts, request.requiredFields);
  const collected = executableValues(request.schema, merged.value, summary);
  if (summary.valid) return { status: 'ready', input: collected };
  return { status: 'collecting', state: collectionState(request, collected, summary), summary };
}

/** 将字段级状态转换为可直接展示的通用中文澄清，不要求用户记忆字段 ID。 */
export function parameterCollectionReply(state: Extract<CollectionState, { kind: 'parameters' }>): string {
  const lines: string[] = [];
  if (state.missingFields.length > 0) lines.push(`请补充以下信息：${formatFields(state, state.missingFields)}。`);
  if (state.invalidFields.length > 0) lines.push(`以下信息不符合输入格式，请修改：${formatFields(state, state.invalidFields)}。`);
  if (state.conflictFields.length > 0) lines.push(`以下信息出现不一致，请确认最终值：${formatFields(state, state.conflictFields)}。`);
  return lines.length > 0 ? lines.join('\n') : '请补充符合输入契约的信息后继续。';
}

/** 同时展示中文字段说明和稳定字段标识，避免把协议字段直接丢给用户。 */
function formatFields(state: Extract<CollectionState, { kind: 'parameters' }>, fields: readonly string[]): string {
  return fields.map((field) => {
    const label = state.presentation?.[field]?.label ?? defaultFieldLabel(field);
    return `${label}（${field}）`;
  }).join('、');
}

/** 仅对通用协议字段提供固定中文别名，不包含任何业务域词汇。 */
function defaultFieldLabel(field: string): string {
  const labels: Record<string, string> = { operation: '操作', query: '查询内容', params: '参数' };
  return labels[field] ?? '参数';
}

/** 仅沿用同一 Function、Plugin 和 Schema 版本的旧收集状态。 */
function sameCollection(previous: ParameterCollectionRequest['previous'], request: ParameterCollectionRequest): ParameterCollectionRequest['previous'] {
  if (previous?.functionId !== request.functionId || previous.schemaVersion !== request.schemaVersion || previous.pluginId !== request.pluginId) return undefined;
  return previous;
}

/** 将旧值与当前值合并，并记录不可静默覆盖的字段冲突。 */
function mergeValues(previous: Record<string, JsonValue> | undefined, incoming: Record<string, JsonValue>, previouslyConflicted: readonly string[] = []): { value: Record<string, JsonValue>; conflicts: string[] } {
  const value = { ...(previous ?? {}) };
  const conflicts: string[] = [];
  mergeNamedValues(value, incoming, previouslyConflicted, conflicts);
  return { value, conflicts };
}

/** 递归按字段名合并对象，当前轮值始终覆盖旧值。 */
function mergeNamedValues(target: Record<string, JsonValue>, incoming: Record<string, JsonValue>, previouslyConflicted: readonly string[], conflicts: string[], prefix = ''): void {
  for (const [field, next] of Object.entries(incoming)) {
    const path = prefix.length > 0 ? `${prefix}.${field}` : field;
    const current = target[field];
    if (isRecord(current) && isRecord(next)) {
      mergeNamedValues(current, next, previouslyConflicted, conflicts, path);
      continue;
    }
    if (!previouslyConflicted.includes(path) && Object.hasOwn(target, field) && JSON.stringify(current) !== JSON.stringify(next)) conflicts.push(path);
    target[field] = next;
  }
}

/** 只保留 Schema 已声明且未被字段级校验标记的值。 */
function executableValues(schema: JsonSchema, value: Record<string, JsonValue>, summary: ParameterValidationSummary): Record<string, JsonValue> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(Object.entries(value).filter(([field]) => Object.hasOwn(properties, field) && !summary.invalidFields.includes(field)).slice(0, MAX_COLLECTION_FIELDS));
}

/** 构造可恢复的参数收集状态和界面字段控制类型。 */
function collectionState(request: ParameterCollectionRequest, collected: Record<string, JsonValue>, summary: ParameterValidationSummary): Extract<CollectionState, { kind: 'parameters' }> {
  const attempt = Math.max(1, Math.min(MAX_COLLECTION_ATTEMPTS, request.attempt));
  return {
    kind: 'parameters',
    functionId: request.functionId.slice(0, MAX_COLLECTION_FIELD_LENGTH),
    ...(request.pluginId === undefined ? {} : { pluginId: request.pluginId.slice(0, MAX_COLLECTION_FIELD_LENGTH) }),
    schemaVersion: request.schemaVersion.slice(0, MAX_COLLECTION_FIELD_LENGTH),
    collected,
    missingFields: summary.missingFields.slice(0, MAX_COLLECTION_FIELDS),
    invalidFields: summary.invalidFields.slice(0, MAX_COLLECTION_FIELDS),
    conflictFields: summary.conflictFields.slice(0, MAX_COLLECTION_FIELDS),
    attempt,
    presentation: buildPresentation(request.schema, summary.expectedFields)
  };
}

/** 从 Schema 属性生成不含执行权限的表单展示元数据。 */
function buildPresentation(schema: JsonSchema, expectedFields: readonly string[]): NonNullable<Extract<CollectionState, { kind: 'parameters' }>['presentation']> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.fromEntries(expectedFields.slice(0, MAX_COLLECTION_FIELDS).map((field) => {
    const property = isRecord(properties[field]) ? properties[field] : {};
    const title = typeof property.title === 'string' ? property.title.slice(0, MAX_CLARIFICATION_LABEL_LENGTH) : undefined;
    const description = typeof property.description === 'string' ? property.description.slice(0, MAX_CLARIFICATION_LABEL_LENGTH) : undefined;
    const control = controlFor(property);
    const options = optionValues(property);
    return [field.slice(0, MAX_COLLECTION_FIELD_LENGTH), { ...(title === undefined ? {} : { label: title }), ...(description === undefined ? {} : { description }), ...(control === undefined ? {} : { control }), ...(options === undefined ? {} : { options }) }];
  }));
}

/**
 * 将 Schema 枚举值转换为有限的可读选项，不改变传入值。
 * @param property - Schema 属性定义
 * @returns 有界的可读选项，未声明枚举时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-23
 */
function optionValues(property: Record<string, unknown>): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(property.enum)) return undefined;
  const options = property.enum.filter((value): value is string => typeof value === 'string').slice(0, MAX_CLARIFICATION_OPTIONS);
  return options.length === 0 ? undefined : options.map((value) => ({ value, label: value }));
}

/** 将 JSON Schema 基础类型映射为有限界面控件。 */
function controlFor(property: Record<string, unknown>): 'text' | 'number' | 'boolean' | 'select' | 'multi-select' | 'object' | undefined {
  if (Array.isArray(property.enum) && property.enum.length > 0) return 'select';
  if (property.type === 'boolean') return 'boolean';
  if (property.type === 'number' || property.type === 'integer') return 'number';
  if (property.type === 'array') return 'multi-select';
  if (property.type === 'object') return 'object';
  if (property.type === 'string') return 'text';
  return undefined;
}

/** 将非数组对象收敛为顶层 JSON 参数记录。 */
function toRecord(value: unknown): Record<string, JsonValue> {
  return isRecord(value) ? value as Record<string, JsonValue> : {};
}

/** 判断值是否为可枚举的 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
