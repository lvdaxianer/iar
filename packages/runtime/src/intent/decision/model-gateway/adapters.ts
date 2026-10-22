/**
 * 提供 Semantic、JEV、Compaction 和 Response 的 role-specific 输出验证适配器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ACTION_TYPES, MAX_RECENT_MESSAGE_CHARS, MAX_RECENT_MESSAGE_LIMIT, validateContract, type ActionType, type BehaviorContext, type CompactionResult, type DecisionResult, type JsonValue } from '@iar/contracts';
import { validateDecisionOutput } from '../validation.js';
import type { DecisionRequest } from '../types.js';
import { MODEL_NO_PROFILE_MESSAGE, type ModelGatewayInvocationOptions, type ModelGatewayResult, type ModelInvocation, type ModelOutputValidation } from './types.js';
import { ModelGateway } from './gateway.js';
import { DecisionBackendResolver } from './decision-backend.js';
import { buildIntentDecisionInput, canonicalizeDecisionRequest } from './intent-prompt.js';
import { validateFunctionCallProposal, validateNestedFunctionCallProposal, type FunctionCallProposal, type FunctionToolDefinition, type NestedFunctionCallProposal, type NestedFunctionCandidateDefinition, type NestedFunctionToolDefinition } from './function-call.js';

/** Semantic Extractor 的最小结构化返回。 */
export type SemanticFrame = {
  /** SemanticFrame schema 版本。 */
  schemaVersion: 'iar.semantic-frame/v1' | 'iar.semantic-frame/v2';
  /** 可供 FunctionRule 使用的主语片段。 */
  subject?: { type?: string; id?: string; source?: 'input' | 'context' | 'event' | 'plugin' };
  /** 结构化意图。 */
  intent: string;
  /** 第一阶段提出的 Plugin 标识，运行时必须重新校验。 */
  pluginId?: string;
  /** 结构化动作；缺失的旧模型输出会在边界归一化为 unknown。 */
  action: SemanticActionType;
  /** 只承载 JSON-safe 槽位事实。 */
  slots: Record<string, JsonValue>;
  /** 输入文本中的通用历史关系。 */
  references: Array<LegacySemanticReference | HistoricalSemanticReference>;
  /** 0 到 1 的模型置信度。 */
  confidence: number;
};

/** 旧版引用结构，仅用于兼容 v1 空间。 */
export type LegacySemanticReference = { text: string; resolvedTo: string };

/** 新版引用结构，只表达不透明记录与顺序关系。 */
export type HistoricalSemanticReference = {
  text: string;
  anchorRecordId?: string;
  relation: 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset';
  scope?: 'same_fact_chain';
  offset?: number;
};

/** 历史关系的有限运行时集合。 */
const REFERENCE_RELATIONS = new Set(['current', 'previous', 'next', 'first', 'last', 'offset']);

/** offset 关系允许的相对位置边界。 */
const MAX_REFERENCE_OFFSET = 64;

/** Semantic Extractor 可以表达的固定动作集合。 */
export type SemanticActionType = ActionType | 'unknown';

/** Semantic Extractor 的调用输入。 */
export type SemanticExtractInvocation = ModelInvocation;

/** JEV Decision 的调用输入。 */
export type JevDecisionInvocation = Omit<ModelInvocation, 'input'> & { request: DecisionRequest; currentMessage?: string; behaviorContext?: BehaviorContext; recentMessages?: Array<{ role: string; text: string }> };

/**
 * Intent Model Decision 与 JEV 共用同一受限请求输入。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type IntentModelDecisionInvocation = JevDecisionInvocation;

/** Context Compactor 的调用输入。 */
export type ContextCompactInvocation = Omit<ModelInvocation, 'input'> & { input: JsonValue };

/** Response Generator 的调用输入。 */
export type ResponseGenerateInvocation = ModelInvocation;

/** Function-call 的调用输入，工具列表必须来自已选 Plugin 的安装记录。 */
export type FunctionCallInvocation = Omit<ModelInvocation, 'input'> & { input: JsonValue; tools: readonly FunctionToolDefinition[] };

/** Nested Plugin tool 的调用输入，工具列表必须来自当前 PluginHost 投影。 */
export type NestedFunctionCallInvocation = Omit<ModelInvocation, 'input'> & { input: JsonValue; tools: readonly NestedFunctionToolDefinition[] };

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

/** 使用指定 backend 执行一次受限 Function-call。 */
export class FunctionCallAdapter {
  /** 创建绑定 backend 的 Function-call adapter。 */
  public constructor(private readonly gateway: ModelGateway, private readonly backend?: 'jev' | 'intent-model') {}

  /**
   * 发送当前 Plugin 工具集合并校验模型提案。
   * @param invocation - trace/run、结构化上下文和已安装工具
   * @param profileId - 可选的 backend primary profile
   * @param options - 可选跨 backend fallback
   * @returns 受约束 Function-call 提案或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-22
   */
  public call(invocation: FunctionCallInvocation, profileId?: string, options?: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>): Promise<ModelGatewayResult<FunctionCallProposal>> {
    const snapshot = snapshotFunctionCallInvocation(invocation);
    if (!snapshot) return Promise.resolve(invalidFunctionCallResult('Function-call 输入无效'));
    const input = withFunctionTools(snapshot.input, snapshot.tools);
    const gatewayOptions = this.backend ? decisionOptions(this.backend, profileId, options) : undefined;
    return this.gateway.invoke('function.call', { traceId: snapshot.traceId, runId: snapshot.runId, input }, (raw) => validateFunctionCallProposal(raw, snapshot.tools), gatewayOptions);
  }
}

/** 使用一个 OpenAI nested Plugin tool 提出完整 Function/Operation 调用。 */
export class NestedFunctionCallAdapter {
  /** 创建绑定 backend 的 nested Function-call adapter。 */
  public constructor(private readonly gateway: ModelGateway, private readonly backend?: 'jev' | 'intent-model') {}

  /** 发送当前 Plugin tools 并校验完整的 nested proposal。 */
  public call(invocation: NestedFunctionCallInvocation, profileId?: string, options?: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>): Promise<ModelGatewayResult<NestedFunctionCallProposal>> {
    const snapshot = snapshotNestedFunctionCallInvocation(invocation);
    if (!snapshot) return Promise.resolve(invalidNestedFunctionCallResult('Nested Function-call 输入无效'));
    const input = withNestedFunctionTools(snapshot.input, snapshot.tools);
    const gatewayOptions = this.backend ? decisionOptions(this.backend, profileId, options) : undefined;
    return this.gateway.invoke('function.call', { traceId: snapshot.traceId, runId: snapshot.runId, input }, (raw) => validateNestedFunctionCallProposal(raw, snapshot.tools), gatewayOptions);
  }
}

/** 按 JEV 优先、Intent Model 其次执行 Function-call。 */
export class UnifiedFunctionCallAdapter {
  /** 创建统一 Function-call 入口。 */
  public constructor(private readonly resolver: DecisionBackendResolver, private readonly jevAdapter: FunctionCallAdapter, private readonly intentModelAdapter: FunctionCallAdapter) {}

  /** 解析 backend 后只调用一个 Function-call provider。 */
  public call(invocation: FunctionCallInvocation): Promise<ModelGatewayResult<FunctionCallProposal>> {
    try {
      const resolution = this.resolver.resolve('function.call');
      const adapter = resolution.backend === 'jev' ? this.jevAdapter : this.intentModelAdapter;
      return adapter.call(invocation, resolution.profileId);
    } catch {
      return Promise.resolve(noProfileResult());
    }
  }
}

/** 按 JEV 优先、Intent Model 其次执行 nested Function-call。 */
export class UnifiedNestedFunctionCallAdapter {
  /** 创建统一 nested Function-call 入口。 */
  public constructor(private readonly resolver: DecisionBackendResolver, private readonly jevAdapter: NestedFunctionCallAdapter, private readonly intentModelAdapter: NestedFunctionCallAdapter) {}

  /** 解析 backend 后只调用一个 nested Function-call provider。 */
  public call(invocation: NestedFunctionCallInvocation): Promise<ModelGatewayResult<NestedFunctionCallProposal>> {
    try {
      const resolution = this.resolver.resolve('function.call');
      const adapter = resolution.backend === 'jev' ? this.jevAdapter : this.intentModelAdapter;
      return adapter.call(invocation, resolution.profileId);
    } catch {
      return Promise.resolve(noProfileResult());
    }
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
  public decide(invocation: JevDecisionInvocation, profileId?: string, options?: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>): Promise<ModelGatewayResult<DecisionResult>> {
    // 先建立唯一请求快照，避免 role、gateway input 和 validator 分别读取可变输入。
    const snapshot = createDecisionInvocationSnapshot(invocation, this.role);
    if (!snapshot) return Promise.resolve(invalidJevResult('JEV decision 输入无效'));
    const crossBackendInput = options?.crossBackendFallback === true ? buildIntentDecisionInput(snapshot.request, snapshot.currentMessage, snapshot.behaviorContext, snapshot.recentMessages) : undefined;
    return this.gateway.invoke(this.role, { traceId: snapshot.traceId, runId: snapshot.runId, input: decisionModelInput(snapshot.request, snapshot.currentMessage, snapshot.behaviorContext, snapshot.recentMessages) }, (raw) => validateDecisionResult(snapshot.request, raw), decisionOptions('jev', profileId, options, crossBackendInput));
  }
}

/**
 * 使用 ModelGateway 运行版本化 Intent Model Decision。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class IntentModelDecisionAdapter {
  /**
   * 创建绑定 decision role 的 Intent Model adapter。
   * @param gateway - 统一模型调用边界
   * @param role - function.select 或 plugin.select
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly gateway: ModelGateway, private readonly role: 'function.select' | 'plugin.select') {}

  /**
   * 构造 Prompt 输入并校验 Intent Model 的统一 DecisionResult。
   * @param invocation - trace/run 和有限候选请求
   * @returns 受约束的 DecisionResult 或稳定模型错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public decide(invocation: IntentModelDecisionInvocation, profileId?: string, options?: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>): Promise<ModelGatewayResult<DecisionResult>> {
    // role 不匹配、getter 异常或请求不可复制时，在构造 Prompt 前 fail-closed。
    const snapshot = createDecisionInvocationSnapshot(invocation, this.role);
    if (!snapshot) return Promise.resolve(invalidDecisionResult('Intent Model decision request 无效'));
    let input: JsonValue;
    try {
      input = buildIntentDecisionInput(snapshot.request, snapshot.currentMessage, snapshot.behaviorContext, snapshot.recentMessages);
    } catch {
      // Prompt builder 的底层异常统一收敛为稳定 invalid_request。
      return Promise.resolve(invalidDecisionResult('Intent Model decision request 无效'));
    }
    const crossBackendInput = options?.crossBackendFallback === true ? decisionModelInput(snapshot.request, snapshot.currentMessage, snapshot.behaviorContext, snapshot.recentMessages) : undefined;
    return this.gateway.invoke(this.role, { traceId: snapshot.traceId, runId: snapshot.runId, input }, (raw) => validateDecisionResult(snapshot.request, raw), decisionOptions('intent-model', profileId, options, crossBackendInput));
  }
}

/**
 * 通过 resolver 选择一个 backend 并只委托一个具体决策 adapter。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class UnifiedDecisionAdapter {
  /** 跨 backend fallback 只在构造时显式开启，默认关闭。 */
  private readonly options: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>;
  /**
   * 创建统一决策入口。
   * @param resolver - 按 JEV 优先级解析 backend
   * @param jevAdapter - JEV 专用 adapter
   * @param intentModelAdapter - Intent Model 专用 adapter
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly resolver: DecisionBackendResolver, private readonly jevAdapter: JevDecisionAdapter, private readonly intentModelAdapter: IntentModelDecisionAdapter, options: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'> = {}) {
    this.options = options;
  }

  /**
   * 解析 backend 并执行一次统一决策。
   * @param invocation - trace/run 和有限候选请求
   * @returns 不区分 backend 的统一 DecisionResult 结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public decide(invocation: JevDecisionInvocation): Promise<ModelGatewayResult<DecisionResult>> {
    // 统一入口先拒绝 malformed 请求，避免 resolver 或 provider 观察无效数据。
    const snapshot = createDecisionInvocationSnapshot(invocation);
    if (!snapshot) return Promise.resolve(invalidDecisionResult('统一 decision request 无效'));
    try {
      const resolution = this.resolver.resolve(snapshot.request.decisionType);
      return resolution.backend === 'jev' ? this.jevAdapter.decide(snapshot, resolution.profileId, this.options) : this.intentModelAdapter.decide(snapshot, resolution.profileId, this.options);
    } catch {
      // resolver 配置异常不能把内部 role/profile message 暴露给调用方。
      return Promise.resolve(noProfileResult());
    }
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
    return this.gateway.invoke('context.compact', { ...invocation, input: sanitizeCompactionInput(invocation.input) }, validateCompactionResult);
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
  /** 可选的有限澄清元数据，只表达下一轮输入，不包含执行权限。 */
  clarification?: ClarificationMetadata;
};

/** Response Generator 可以请求的有限澄清状态。 */
export type ClarificationMetadata = {
  kind: 'slot' | 'selection' | 'input';
  status: 'required';
  options?: Array<{ key: string; label: string }>;
};

/** 校验 SemanticFrame 输出并复制成稳定对象。 */
/** 校验 SemanticFrame 输出。 @param raw - provider 原始输出 @returns 结构化验证结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateSemanticFrame(raw: unknown): ModelOutputValidation<SemanticFrame> {
  // SemanticFrame 只允许抽取字段，未知字段不能进入规则引擎。
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'subject', 'intent', 'pluginId', 'action', 'slots', 'references', 'confidence'])) return { ok: false, message: 'SemanticFrame Schema 无效' };
  const schemaVersion = raw.schemaVersion;
  if (!isSemanticFrameVersion(schemaVersion) || !isNonEmptyString(raw.intent) || (raw.pluginId !== undefined && !isNonEmptyString(raw.pluginId)) || !isRecord(raw.slots) || !isJsonValue(raw.slots) || !Array.isArray(raw.references) || !raw.references.every((reference) => isReference(reference, schemaVersion)) || typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 || (raw.subject !== undefined && !isSubject(raw.subject)) || (raw.action !== undefined && !isSemanticActionType(raw.action))) return { ok: false, message: 'SemanticFrame Schema 无效' };
  return { ok: true, value: { ...structuredClone(raw) as Omit<SemanticFrame, 'action'> & { action?: SemanticActionType }, action: raw.action ?? 'unknown' } };
}

/** 只允许固定动作类型进入路由事实，避免模型动态创造动作语义。 */
function isSemanticActionType(value: unknown): value is SemanticActionType {
  return value === 'unknown' || ACTION_TYPES.includes(value as ActionType);
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
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['schemaVersion', 'text', 'citations', 'clarification']) || raw.schemaVersion !== 'iar.response/v1' || !isNonEmptyString(raw.text) || (raw.citations !== undefined && (!Array.isArray(raw.citations) || !raw.citations.every(isNonEmptyString))) || (raw.clarification !== undefined && !isClarificationMetadata(raw.clarification))) return { ok: false, message: 'Response Schema 无效' };
  return { ok: true, value: structuredClone(raw) as GeneratedResponse };
}

/** 校验澄清元数据的数量、长度和选项唯一性。 */
function isClarificationMetadata(value: unknown): value is ClarificationMetadata {
  if (!isRecord(value) || !['slot', 'selection', 'input'].includes(String(value.kind)) || value.status !== 'required') return false;
  if (value.options === undefined) return true;
  if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 12) return false;
  const keys = new Set<string>();
  return value.options.every((option) => {
    if (!isRecord(option) || !isNonEmptyString(option.key) || option.key.length > 60 || !isNonEmptyString(option.label) || option.label.length > 200 || keys.has(option.key)) return false;
    keys.add(option.key);
    return true;
  });
}

/** 校验 SemanticFrame 的 subject 片段。 */
/** 校验 SemanticFrame subject。 @param value - 未知 subject @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isSubject(value: unknown): boolean {
  // subject 只允许展示/事实字段，不能携带 route 或 action 权限。
  return isRecord(value) && hasOnlyKeys(value, ['type', 'id', 'source']) && Object.entries(value).every(([key, item]) => (key === 'source' ? item === 'input' || item === 'context' || item === 'event' || item === 'plugin' : isNonEmptyString(item)));
}

/** 校验引用只包含展示文本和稳定目标。 */
/** 校验 SemanticFrame reference。 @param value - 未知引用 @returns 是否合法 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isReference(value: unknown, schemaVersion: SemanticFrame['schemaVersion']): boolean {
  if (schemaVersion === 'iar.semantic-frame/v1') return isRecord(value) && hasOnlyKeys(value, ['text', 'resolvedTo']) && isNonEmptyString(value.text) && isNonEmptyString(value.resolvedTo);
  if (!isRecord(value) || !hasOnlyKeys(value, ['text', 'anchorRecordId', 'relation', 'scope', 'offset']) || !isNonEmptyString(value.text) || typeof value.relation !== 'string' || !REFERENCE_RELATIONS.has(value.relation)) return false;
  if (value.anchorRecordId !== undefined && !isNonEmptyString(value.anchorRecordId)) return false;
  if (value.scope !== undefined && value.scope !== 'same_fact_chain') return false;
  if (value.relation === 'offset') return typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && Math.abs(value.offset) <= MAX_REFERENCE_OFFSET;
  return value.offset === undefined;
}

/** 判断 SemanticFrame 是否使用当前支持的版本。 */
function isSemanticFrameVersion(value: unknown): value is SemanticFrame['schemaVersion'] {
  return value === 'iar.semantic-frame/v1' || value === 'iar.semantic-frame/v2';
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

/**
 * 只把结构化上下文和不可变事件交给压缩模型，拒绝最近消息原文。
 *
 * @param input - 调用方提供的压缩输入
 * @returns 仅包含压缩模型允许读取字段的 JSON 输入
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function sanitizeCompactionInput(input: JsonValue): JsonValue {
  if (!isRecord(input)) return input;
  return {
    ...(input.behaviorContext === undefined ? {} : { behaviorContext: input.behaviorContext as JsonValue }),
    ...(input.eventsToCompact === undefined ? {} : { eventsToCompact: input.eventsToCompact as JsonValue })
  };
}

/** 构造不含原始输入的 JEV invalid_request。 @param message - 稳定错误摘要 @returns JEV 失败结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function invalidJevResult<T>(message: string): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message, retryable: false, details: {} }, audit: [], events: [] };
}

/** 创建一次决策调用快照，并把所有 Proxy/getter 异常收敛为 undefined。 @param invocation - 未信任调用 @param role - 可选期望 role @returns 安全快照或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function createDecisionInvocationSnapshot(invocation: unknown, role?: 'function.select' | 'plugin.select'): JevDecisionInvocation | undefined {
  try {
    if (!isRecord(invocation)) return undefined;
    const traceId = invocation.traceId;
    const runId = invocation.runId;
    if (!isNonEmptyString(traceId) || !isNonEmptyString(runId)) return undefined;
    const request = canonicalizeDecisionRequest(invocation.request);
    if (role !== undefined && request.decisionType !== role) return undefined;
    const currentMessage = invocation.currentMessage === undefined ? undefined : snapshotMessage(invocation.currentMessage);
    if (invocation.currentMessage !== undefined && currentMessage === undefined) return undefined;
    const behaviorContext = invocation.behaviorContext === undefined ? undefined : snapshotBehaviorContext(invocation.behaviorContext);
    if (invocation.behaviorContext !== undefined && behaviorContext === undefined) return undefined;
    const recentMessages = invocation.recentMessages === undefined ? undefined : snapshotRecentMessages(invocation.recentMessages);
    if (invocation.recentMessages !== undefined && recentMessages === undefined) return undefined;
    return { traceId, runId, request, ...(currentMessage === undefined ? {} : { currentMessage }), ...(behaviorContext === undefined ? {} : { behaviorContext }), ...(recentMessages === undefined ? {} : { recentMessages }) };
  } catch {
    // Proxy、getter、循环引用和不可复制值都不能进入异步 provider 生命周期。
    return undefined;
  }
}

/** 构造两个决策 backend 共用的上下文输入，保持 DecisionResult 契约不变。 */
function decisionModelInput(request: DecisionRequest, currentMessage: string | undefined, behaviorContext: BehaviorContext | undefined, recentMessages?: Array<{ role: string; text: string }>): JsonValue {
  if (currentMessage === undefined && behaviorContext === undefined && recentMessages === undefined) return request as unknown as JsonValue;
  return { ...request, ...(currentMessage === undefined ? {} : { currentMessage }), ...(behaviorContext === undefined ? {} : { behaviorContext }), ...(recentMessages === undefined ? {} : { recentMessages }) } as unknown as JsonValue;
}

/** 校验并复制送入决策模型的有界最近消息窗口。 */
function snapshotRecentMessages(value: unknown): Array<{ role: string; text: string }> | undefined {
  if (!Array.isArray(value) || value.length > MAX_RECENT_MESSAGE_LIMIT) return undefined;
  const result = value.map((item) => {
    if (!isRecord(item) || !['user', 'assistant', 'system'].includes(String(item.role)) || typeof item.text !== 'string') return undefined;
    return { role: String(item.role), text: item.text.slice(0, MAX_RECENT_MESSAGE_CHARS) };
  });
  return result.every((item): item is { role: string; text: string } => item !== undefined) ? result : undefined;
}

/** 限制送入决策模型的当前问题长度，并隔离调用方可变字符串。 */
function snapshotMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 4000 ? `${value}` : undefined;
}

/** 只允许经过 BehaviorContext Schema 的结构化快照进入模型调用。 */
function snapshotBehaviorContext(value: unknown): BehaviorContext | undefined {
  try {
    const snapshot = structuredClone(value);
    const validation = validateContract('behaviorContext', snapshot);
    return validation.ok ? structuredClone(validation.value) as BehaviorContext : undefined;
  } catch {
    return undefined;
  }
}

/** 创建 backend-aware gateway 选项。 @param backend - 选定 backend @param profileId - resolver 选出的 primary profile @returns gateway 选择约束 @author lvdaxianer@yeah.net @date 2026-10-17 */
function decisionOptions(backend: 'jev' | 'intent-model', profileId?: string, options?: Pick<ModelGatewayInvocationOptions, 'crossBackendFallback'>, crossBackendInput?: JsonValue): ModelGatewayInvocationOptions {
  const selected: ModelGatewayInvocationOptions = profileId ? { decisionBackend: backend, profileId } : { decisionBackend: backend };
  if (options?.crossBackendFallback !== true) return selected;
  return { ...selected, crossBackendFallback: true, ...(crossBackendInput !== undefined ? { crossBackendInput } : {}) };
}

/** 创建不含原始请求内容的统一 invalid_request。 @param message - 稳定错误摘要 @returns 决策失败结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function invalidDecisionResult<T>(message: string): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message, retryable: false, details: {} }, audit: [], events: [] };
}

/** 创建不暴露 resolver 配置细节的 model.no_profile。 @returns 稳定配置错误结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function noProfileResult<T>(): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.no_profile', message: MODEL_NO_PROFILE_MESSAGE, retryable: false, details: {} }, audit: [], events: [] };
}

/** 创建 Function-call 的不可变调用快照。 */
function snapshotFunctionCallInvocation(invocation: unknown): FunctionCallInvocation | undefined {
  try {
    if (!isRecord(invocation) || !isNonEmptyString(invocation.traceId) || !isNonEmptyString(invocation.runId) || !Array.isArray(invocation.tools) || invocation.tools.length === 0) return undefined;
    const input = structuredClone(invocation.input) as JsonValue;
    const tools = structuredClone(invocation.tools) as FunctionToolDefinition[];
    if (!isJsonValue(input) || !tools.every(isFunctionTool)) return undefined;
    return { traceId: invocation.traceId, runId: invocation.runId, input, tools };
  } catch {
    return undefined;
  }
}

/** 创建 nested Function-call 的不可变调用快照。 */
function snapshotNestedFunctionCallInvocation(invocation: unknown): NestedFunctionCallInvocation | undefined {
  try {
    if (!isRecord(invocation) || !isNonEmptyString(invocation.traceId) || !isNonEmptyString(invocation.runId) || !Array.isArray(invocation.tools) || invocation.tools.length === 0) return undefined;
    const input = structuredClone(invocation.input) as JsonValue;
    const tools = structuredClone(invocation.tools) as NestedFunctionToolDefinition[];
    if (!isJsonValue(input) || !tools.every(isNestedFunctionTool)) return undefined;
    return { traceId: invocation.traceId, runId: invocation.runId, input, tools };
  } catch {
    return undefined;
  }
}

/** 将已安装工具加入 provider 输入，不能从模型输出反向扩展。 */
function withFunctionTools(input: JsonValue, tools: readonly FunctionToolDefinition[]): JsonValue {
  if (!isRecord(input)) return { input, tools: tools as unknown as JsonValue };
  return { ...input, tools: tools as unknown as JsonValue };
}

/** 将 nested Plugin tools 放入 provider 输入，不能由模型反向扩展。 */
function withNestedFunctionTools(input: JsonValue, tools: readonly NestedFunctionToolDefinition[]): JsonValue {
  if (!isRecord(input)) return { input, nestedTools: tools as unknown as JsonValue };
  return { ...input, nestedTools: tools as unknown as JsonValue };
}

/** 判断 Function 工具快照是否具备最小固定字段。 */
function isFunctionTool(value: unknown): value is FunctionToolDefinition {
  return isRecord(value) && isNonEmptyString(value.name) && isNonEmptyString(value.pluginId) && isNonEmptyString(value.functionId) && isNonEmptyString(value.description) && isJsonValue(value.parameters);
}

/** 判断 nested Plugin tool 快照是否具备固定字段。 */
function isNestedFunctionTool(value: unknown): value is NestedFunctionToolDefinition {
  return isRecord(value) && isNonEmptyString(value.name) && isNonEmptyString(value.pluginId) && isNonEmptyString(value.description) && isJsonValue(value.parameters) && Array.isArray(value.candidates) && value.candidates.every(isNestedFunctionCandidate);
}

/** 判断 nested Function 候选是否保留 Plugin、Function 和 Operation 归属。 */
function isNestedFunctionCandidate(value: unknown): value is NestedFunctionCandidateDefinition {
  return isRecord(value) && isNonEmptyString(value.pluginId) && isNonEmptyString(value.functionId) && Array.isArray(value.operations) && value.operations.length > 0 && value.operations.every((operation) => isRecord(operation) && isNonEmptyString(operation.name));
}

/** 创建稳定的 Function-call 输入错误。 */
function invalidFunctionCallResult<T>(message: string): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message, retryable: false, details: {} }, audit: [], events: [] };
}

/** 创建 nested Function-call 的稳定输入错误。 */
function invalidNestedFunctionCallResult<T>(message: string): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message, retryable: false, details: {} }, audit: [], events: [] };
}
