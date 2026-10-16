/**
 * 提供 Semantic、JEV、Compaction 和 Response 的 role-specific 输出验证适配器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { validateContract, type CompactionResult, type DecisionResult, type JsonValue } from '@iar/contracts';
import { validateDecisionOutput } from '../validation.js';
import type { DecisionRequest } from '../types.js';
import type { ModelGatewayResult, ModelInvocation, ModelOutputValidation } from './types.js';
import { ModelGateway } from './gateway.js';

/** Semantic Extractor 的最小结构化返回。 */
export type SemanticFrame = {
  /** SemanticFrame schema 版本。 */
  schemaVersion: 'iar.semantic-frame/v1';
  /** 可供 FunctionRule 使用的主语片段。 */
  subject?: { type?: string; id?: string; source?: 'input' | 'context' | 'event' | 'plugin' };
  /** 结构化意图。 */
  intent: string;
  /** 结构化动作。 */
  action?: string;
  /** 只承载 JSON-safe 槽位事实。 */
  slots: Record<string, JsonValue>;
  /** 输入文本中的引用解析。 */
  references: Array<{ text: string; resolvedTo: string }>;
  /** 0 到 1 的模型置信度。 */
  confidence: number;
};

/** Semantic Extractor 的调用输入。 */
export type SemanticExtractInvocation = ModelInvocation;

/** JEV Decision 的调用输入。 */
export type JevDecisionInvocation = Omit<ModelInvocation, 'input'> & { request: DecisionRequest };

/** Context Compactor 的调用输入。 */
export type ContextCompactInvocation = Omit<ModelInvocation, 'input'> & { input: JsonValue };

/** Response Generator 的调用输入。 */
export type ResponseGenerateInvocation = ModelInvocation;

/** 使用 ModelGateway 运行 Semantic Extractor。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class SemanticExtractorAdapter {
  /** 创建 Semantic Extractor adapter。 @param gateway - 统一模型调用边界 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(private readonly gateway: ModelGateway) {}

  /**
   * 抽取 SemanticFrame，并拒绝未声明字段或非法置信度。
   * @param invocation - trace/run 和待抽取输入
   * @returns 结构化 SemanticFrame 或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public extract(invocation: SemanticExtractInvocation): Promise<ModelGatewayResult<SemanticFrame>> {
    return this.gateway.invoke('semantic.extract', invocation, validateSemanticFrame);
  }
}

/** 使用 ModelGateway 运行 Function/Plugin 两阶段 JEV Decision。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class JevDecisionAdapter {
  /**
   * 创建绑定 decision role 的 JEV adapter。
   * @param gateway - 统一模型调用边界
   * @param role - function.select 或 plugin.select
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly gateway: ModelGateway, private readonly role: 'function.select' | 'plugin.select') {}

  /**
   * 产生经过本地候选集和阈值校验的 DecisionResult。
   * @param invocation - trace/run 和有限候选请求
   * @returns 受约束的 DecisionResult 或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public decide(invocation: JevDecisionInvocation): Promise<ModelGatewayResult<DecisionResult>> {
    // role 和 request.decisionType 不一致时拒绝，避免跨阶段复用输出。
    if (!isRecord(invocation) || !isRecord(invocation.request) || !isJsonValue(invocation.request) || invocation.request.decisionType !== this.role) return Promise.resolve(invalidJevResult('JEV decision role 与请求不匹配'));
    let request: DecisionRequest;
    try {
      request = structuredClone(invocation.request);
    } catch {
      // 函数、Proxy 等不可复制输入必须转成稳定 invalid_request。
      return Promise.resolve(invalidJevResult('JEV decision 输入无效'));
    }
    return this.gateway.invoke(this.role, { traceId: invocation.traceId, runId: invocation.runId, input: request as unknown as JsonValue }, (raw) => validateDecisionResult(request, raw));
  }
}

/** 使用 ModelGateway 运行 Context Compactor。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class ContextCompactorAdapter {
  /** 创建 Context Compactor adapter。 @param gateway - 统一模型调用边界 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(private readonly gateway: ModelGateway) {}

  /**
   * 校验 compactionResult Schema，不允许模型携带 Runtime 事件边界。
   * @param invocation - trace/run 和压缩请求
   * @returns 结构化 CompactionResult 或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public compact(invocation: ContextCompactInvocation): Promise<ModelGatewayResult<CompactionResult>> {
    return this.gateway.invoke('context.compact', invocation, validateCompactionResult);
  }
}

/** 使用 ModelGateway 运行 Response Generator。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class ResponseGeneratorAdapter {
  /** 创建 Response Generator adapter。 @param gateway - 统一模型调用边界 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(private readonly gateway: ModelGateway) {}

  /**
   * 生成版本化响应，不允许 provider 返回无界文本对象。
   * @param invocation - trace/run 和响应输入
   * @returns 结构化响应或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public generate(invocation: ResponseGenerateInvocation): Promise<ModelGatewayResult<GeneratedResponse>> {
    return this.gateway.invoke('response.generate', invocation, validateGeneratedResponse);
  }
}

/** Response Generator 的最小结构化输出。 */
export type GeneratedResponse = {
  /** 响应协议版本。 */
  schemaVersion: 'iar.response/v1';
  /** 面向用户或宿主的文本。 */
  text: string;
  /** 可选的稳定引用标识。 */
  citations?: string[];
};

/** 校验 SemanticFrame 输出并复制成稳定对象。 */
/** 校验 SemanticFrame 输出。 @param raw - provider 原始输出 @returns 结构化验证结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateSemanticFrame(raw: unknown): ModelOutputValidation<SemanticFrame> {
  // SemanticFrame 只允许抽取字段，未知字段不能进入规则引擎。
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'subject', 'intent', 'action', 'slots', 'references', 'confidence']) || raw.schemaVersion !== 'iar.semantic-frame/v1' || !isNonEmptyString(raw.intent) || !isRecord(raw.slots) || !isJsonValue(raw.slots) || !Array.isArray(raw.references) || !raw.references.every(isReference) || typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 || (raw.subject !== undefined && !isSubject(raw.subject)) || (raw.action !== undefined && !isNonEmptyString(raw.action))) return { ok: false, message: 'SemanticFrame Schema 无效' };
  return { ok: true, value: structuredClone(raw) as SemanticFrame };
}

/** 校验并归一化 JEV DecisionResult。 */
/** 校验 JEV Decision 输出。 @param request - 本地候选约束 @param raw - provider 原始输出 @returns 决策验证结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateDecisionResult(request: DecisionRequest, raw: unknown): ModelOutputValidation<DecisionResult> {
  // 先过公共 Decision Schema，再应用候选集合和 threshold 语义。
  const schema = validateContract('decision', raw);
  if (!schema.ok) return { ok: false, message: 'DecisionResult Schema 无效' };
  const decision = validateDecisionOutput(request, raw);
  return { ok: true, value: structuredClone(decision), outcome: decision.status === 'choice' ? 'success' : 'rejected', ...(decision.reasonCode === 'score_below_threshold' ? { errorCode: 'model.threshold_rejected' as const } : {}) };
}

/** 校验 compactionResult 公共契约。 */
/** 校验 CompactionResult 公共契约。 @param raw - provider 原始输出 @returns 压缩验证结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateCompactionResult(raw: unknown): ModelOutputValidation<CompactionResult> {
  // compaction 的版本和 additionalProperties 由 contracts 单一来源校验。
  const validation = validateContract('compactionResult', raw);
  return validation.ok ? { ok: true, value: structuredClone(validation.value) as CompactionResult } : { ok: false, message: 'CompactionResult Schema 无效' };
}

/** 校验 response.generate 输出契约。 */
/** 校验 ResponseGenerator 输出。 @param raw - provider 原始输出 @returns 响应验证结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateGeneratedResponse(raw: unknown): ModelOutputValidation<GeneratedResponse> {
  // Response 只返回文本/引用，不能借额外字段携带工具命令。
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'text', 'citations']) || raw.schemaVersion !== 'iar.response/v1' || !isNonEmptyString(raw.text) || (raw.citations !== undefined && (!Array.isArray(raw.citations) || !raw.citations.every(isNonEmptyString)))) return { ok: false, message: 'Response Schema 无效' };
  return { ok: true, value: structuredClone(raw) as GeneratedResponse };
}

/** 校验 SemanticFrame 的 subject 片段。 */
/** 校验 SemanticFrame subject。 @param value - 未知 subject @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSubject(value: unknown): boolean {
  // subject 只允许展示/事实字段，不能携带 route 或 action 权限。
  return isRecord(value) && hasOnlyKeys(value, ['type', 'id', 'source']) && Object.entries(value).every(([key, item]) => (key === 'source' ? item === 'input' || item === 'context' || item === 'event' || item === 'plugin' : isNonEmptyString(item)));
}

/** 校验引用只包含展示文本和稳定目标。 */
/** 校验 SemanticFrame reference。 @param value - 未知引用 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isReference(value: unknown): boolean {
  // 引用目标必须是非空稳定字符串，不能嵌入任意 JSON。
  return isRecord(value) && hasOnlyKeys(value, ['text', 'resolvedTo']) && isNonEmptyString(value.text) && isNonEmptyString(value.resolvedTo);
}

/** 判断对象是否只有声明字段。 */
/** 判断对象是否只有声明字段。 @param value - 未知对象 @param keys - 白名单字段 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  // adapter boundary 对未知字段统一拒绝，避免模型扩展协议。
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/** 判断非空字符串。 */
/** 判断非空字符串。 @param value - 未知值 @returns 是否非空 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isNonEmptyString(value: unknown): value is string {
  // 空文本不能作为意图、响应或引用继续传播。
  return typeof value === 'string' && value.length > 0;
}

/** 判断 JSON-safe 普通对象、数组和值。 */
/** 判断可重放 JSON 值。 @param value - 未知值 @param seen - 当前递归路径 @returns 是否为 JsonValue @author lvdaxianer@yeah.net @date 2026-10-17 */
function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  // slots 只接受可重放 JSON，类实例和循环引用直接失败。
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? Object.keys(value).length === value.length && value.every((item) => isJsonValue(item, seen)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

/** 判断未知值是否为普通对象。 */
/** 判断普通对象。 @param value - 未知值 @returns 是否为普通对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 构造不含原始输入的 JEV invalid_request。 @param message - 稳定错误摘要 @returns JEV 失败结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function invalidJevResult<T>(message: string): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message, retryable: false, details: {} }, audit: [], events: [] };
}
