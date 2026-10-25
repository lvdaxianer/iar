/**
 * 为意图识别模型组装有界、可观测且不截断 JSON 单元的上下文。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-26
 */
import type { JsonValue } from '@iar/contracts';

/** 意图识别链的初始总字符预算。字符预算不是 tokenizer token 计数。 */
export const INTENT_CONTEXT_BUDGET_CHARS = 24_000;

/** 可参与预算组装的上下文层。 */
export type ContextBudgetSection = {
  /** 输出对象中的稳定字段名。 */
  name: string;
  /** 已经经过上游边界校验的 JSON 值。 */
  value: JsonValue;
  /** 必需层超限直接失败，可选层按优先级尝试加入。 */
  priority: 'required' | 'optional';
  /** 可选数组按完整元素从尾部保留，而不是截断 JSON 文本。 */
  itemized?: boolean;
  /** 可选的嵌套路径；缺失时使用 name 作为顶层字段。 */
  path?: readonly string[];
};

/** 供 audit 使用的无原文预算诊断。 */
export type ContextBudgetDiagnostics = {
  /** 配置的总字符预算。 */
  budgetChars: number;
  /** 最终渲染输入的字符数。 */
  measuredChars: number;
  /** 是否发生了可选层或可选数组元素裁剪。 */
  truncated: boolean;
  /** 各可选层最终保留的完整单元数量；不包含原文。 */
  retained: Readonly<Record<string, number>>;
};

/** 预算不足时使用的稳定、可匹配错误。 */
export class IntentContextBudgetError extends Error {
  /** 稳定错误码。 */
  public readonly code = 'intent.context_budget_exceeded' as const;

  /** 创建不携带输入正文的预算错误。 */
  public constructor() {
    super('Intent context exceeds the configured character budget');
    this.name = 'IntentContextBudgetError';
  }
}

/** 上下文序列化失败时不暴露底层实现异常。 */
export class IntentContextSerializationError extends Error {
  /** 创建稳定的内部序列化错误。 */
  public constructor() {
    super('Intent context serialization failed');
    this.name = 'IntentContextSerializationError';
  }
}

/** 预算组装参数。 */
export type AssembleIntentContextOptions = {
  /** 要按声明顺序拼装的上下文层。 */
  sections: readonly ContextBudgetSection[];
  /** 覆盖默认预算，仅供测试和受控调用方调整。 */
  budgetChars?: number;
  /** 将当前上下文投影成 provider 实际接收的字符串；默认是紧凑 JSON。 */
  serialize?: (context: Readonly<Record<string, JsonValue>>) => string;
};

/** 预算组装结果。 */
export type AssembleIntentContextResult = {
  /** 保留完整字段/数组元素的上下文对象。 */
  context: Record<string, JsonValue>;
  /** provider 实际接收的序列化输入。 */
  serialized: string;
  /** 不含用户原文的预算诊断。 */
  diagnostics: ContextBudgetDiagnostics;
};

/**
 * 按“必需层 > 先声明的可选层 > 新的数组元素”组装上下文。
 *
 * 数组只从头部移除完整元素，因此不会产生半条消息、半个轮次或半个事实记录。
 * 必需层一旦超限立即抛出稳定错误，调用方不得带着未预算输入继续请求 provider。
 */
export function assembleIntentContext(options: AssembleIntentContextOptions): AssembleIntentContextResult {
  const budgetChars = options.budgetChars ?? INTENT_CONTEXT_BUDGET_CHARS;
  if (!Number.isSafeInteger(budgetChars) || budgetChars <= 0) throw new TypeError('Intent context budget must be a positive safe integer');
  const serialize = options.serialize ?? ((context: Readonly<Record<string, JsonValue>>) => JSON.stringify(context));
  const required = options.sections.filter((section) => section.priority === 'required');
  const optional = options.sections.filter((section) => section.priority === 'optional');
  assertUniqueSectionNames(options.sections);

  const context: Record<string, JsonValue> = {};
  for (const section of required) context[section.name] = cloneJsonValue(section.value);
  let serialized = safeSerialize(serialize, context);
  if (typeof serialized !== 'string' || serialized.length > budgetChars) throw new IntentContextBudgetError();

  const retained: Record<string, number> = {};
  let truncated = false;
  for (const section of optional) {
    if (section.itemized === true && Array.isArray(section.value)) {
      const items = section.value.map((item) => cloneJsonValue(item));
      const selected = selectNewestItems(context, section, items, serialize, budgetChars);
      if (selected === undefined) {
        truncated = truncated || items.length > 0;
        continue;
      }
      setSectionValue(context, section, selected);
      serialized = safeSerialize(serialize, context);
      retained[section.name] = selected.length;
      if (selected.length !== items.length) truncated = true;
      continue;
    }

    const candidate = cloneJsonValue(section.value);
    const candidateContext = withSectionValue(context, section, candidate);
    const candidateSerialized = safeSerialize(serialize, candidateContext);
    if (candidateSerialized.length > budgetChars) {
      truncated = true;
      continue;
    }
    setSectionValue(context, section, candidate);
    serialized = candidateSerialized;
    retained[section.name] = 1;
  }

  if (serialized.length > budgetChars) throw new IntentContextBudgetError();
  return {
    context,
    serialized,
    diagnostics: { budgetChars, measuredChars: serialized.length, truncated, retained }
  };
}

function selectNewestItems(
  context: Record<string, JsonValue>,
  section: ContextBudgetSection,
  items: JsonValue[],
  serialize: (context: Readonly<Record<string, JsonValue>>) => string,
  budgetChars: number
): JsonValue[] | undefined {
  const emptyContext = withSectionValue(context, section, []);
  const emptySerialized = safeSerialize(serialize, emptyContext);
  if (emptySerialized.length > budgetChars) return undefined;
  let selected: JsonValue[] = [];
  for (let count = 1; count <= items.length; count += 1) {
    const candidate = items.slice(items.length - count);
    const candidateSerialized = safeSerialize(serialize, withSectionValue(context, section, candidate));
    if (candidateSerialized.length > budgetChars) break;
    selected = candidate;
  }
  return selected;
}

function withSectionValue(context: Readonly<Record<string, JsonValue>>, section: ContextBudgetSection, value: JsonValue): Record<string, JsonValue> {
  const copy = cloneJsonValue(context) as Record<string, JsonValue>;
  setSectionValue(copy, section, value);
  return copy;
}

function setSectionValue(context: Record<string, JsonValue>, section: ContextBudgetSection, value: JsonValue): void {
  const path = section.path === undefined ? [section.name] : [...section.path];
  if (path.length === 0 || path.some((part) => part.length === 0)) throw new TypeError('Intent context section paths must be non-empty');
  let target = context;
  for (const part of path.slice(0, -1)) {
    const existing = target[part];
    if (existing === undefined) {
      const nested: Record<string, JsonValue> = {};
      target[part] = nested;
      target = nested;
      continue;
    }
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) throw new TypeError('Intent context section path conflicts with a non-object value');
    target = existing as Record<string, JsonValue>;
  }
  target[path[path.length - 1] as string] = value;
}

function assertUniqueSectionNames(sections: readonly ContextBudgetSection[]): void {
  const names = new Set<string>();
  for (const section of sections) {
    if (!section || typeof section.name !== 'string' || section.name.length === 0 || names.has(section.name)) throw new TypeError('Intent context section names must be unique non-empty strings');
    names.add(section.name);
  }
}

function cloneJsonValue(value: JsonValue): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new IntentContextSerializationError();
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    if (error instanceof IntentContextSerializationError) throw error;
    throw new IntentContextSerializationError();
  }
}

function safeSerialize(serialize: (context: Readonly<Record<string, JsonValue>>) => string, context: Readonly<Record<string, JsonValue>>): string {
  try {
    const serialized = serialize(context);
    if (typeof serialized !== 'string') throw new IntentContextSerializationError();
    return serialized;
  } catch (error) {
    if (error instanceof IntentContextSerializationError) throw error;
    throw new IntentContextSerializationError();
  }
}
