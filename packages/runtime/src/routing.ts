/*
 * 实现 Function-first 的两阶段受限路由。
 *
 * 路由器把 RuleEngine、DecisionProvider 和 PluginHost 串成安全边界。
 * Function 先产生唯一 choice，Plugin 才能读取宿主候选；provider 不能扩权。
 * PluginHost 在候选快照和最终选择阶段都执行状态、归属和授权重验证。
 * 本模块不执行插件、不改变上下文、不调用 Policy Gate 或 confirmation。
 * 结果保留两阶段评估和决策证据，供后续审计、回放和 Workflow 使用。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ACTION_TYPES, ERROR_CODES, MAX_ROUTING_SCOPE_PLUGINS, type ActionType, type BehaviorContext, type DecisionResult, type RoutingScope } from '@iar/contracts';
import { providerFailureResult, type DecisionCandidate, type DecisionProvider, type DecisionRequest, type ModelGatewayResult } from '@iar/decision';
import type { FunctionRule, PluginCandidate, PluginRule, RuleEvaluationFacts, RuleEvaluationResult } from '@iar/rule-engine';
import { RuleEngine } from '@iar/rule-engine';
import type { PluginHost, PluginRecord } from '@iar/plugins';

const DECISION_VERSION = 'runtime.v1';
const DECISION_THRESHOLD = 0.7;

type RouteEvidence = {
  functionId: string;
  functionEvaluation: RuleEvaluationResult;
  functionDecision: DecisionResult;
  pluginEvaluation: RuleEvaluationResult;
  pluginDecision: DecisionResult;
};

type RouteContext = Pick<RouteRequest, 'tenantId' | 'actorId' | 'environment' | 'pluginRules' | 'pluginHost' | 'authorizePlugin'>;
type FinalizeRouteInput = RouteEvidence & { request: RouteContext; routingScope?: RoutingScope };
type MatchedRouteInput = RouteEvidence & { pluginId: string; routingScope?: RoutingScope };

/** 异步模型决策适配器的最小结构，UnifiedDecisionAdapter 可直接满足该接口。 */
export type AsyncDecisionAdapter = {
  /** 使用 trace/run 和有限候选执行一次模型决策。 */
  decide(invocation: { traceId: string; runId: string; request: DecisionRequest; behaviorContext?: BehaviorContext; recentMessages?: Array<{ role: string; text: string }> }): Promise<ModelGatewayResult<DecisionResult>>;
};

/** 授权回调当前正在验证的阶段和不可变宿主记录。 */
export type PluginAuthorizationInput = {
  /** 当前是候选快照还是最终选择重验证。 */
  phase: 'candidate' | 'selected';
  /** 当前请求租户。 */
  tenantId: string;
  /** 当前请求 actor。 */
  actorId: string;
  /** 当前运行环境。 */
  environment: string;
  /** PluginHost 的当前记录快照。 */
  record: PluginRecord;
};

/** 两阶段路由的完整输入边界。 */
export type RouteRequest = {
  /** 当前语义帧和行为上下文的 JSON-safe 事实。 */
  facts: RuleEvaluationFacts;
  /** 本轮模型可读取的结构化会话上下文，不包含原始消息历史。 */
  behaviorContext?: BehaviorContext;
  /** 当前用户问题，和结构化上下文分开传递给决策模型。 */
  currentMessage?: string;
  /** 当前会话的有界原文窗口，仅供模型理解，不参与规则授权。 */
  recentMessages?: Array<{ role: string; text: string }>;
  /** 当前租户边界。 */
  tenantId: string;
  /** 当前 actor 边界。 */
  actorId: string;
  /** 当前执行环境边界。 */
  environment: string;
  /** Function 阶段规则。 */
  functionRules: readonly FunctionRule[];
  /** Plugin 阶段规则。 */
  pluginRules: readonly PluginRule[];
  /** 提供当前 enabled business plugin 的宿主。 */
  pluginHost: PluginHost;
  /** Function 选择 provider。 */
  functionProvider: DecisionProvider;
  /** Plugin 选择 provider。 */
  pluginProvider: DecisionProvider;
  /** 当前租户、actor、环境下的插件授权检查。 */
  authorizePlugin: (input: PluginAuthorizationInput) => boolean;
};

/** 使用 ModelGateway/UnifiedDecisionAdapter 的异步两阶段路由输入。 */
export type AsyncRouteRequest = Omit<RouteRequest, 'functionProvider' | 'pluginProvider'> & {
  /** 当前模型调用 trace 标识。 */
  traceId: string;
  /** 当前模型调用 run 标识。 */
  runId: string;
  /** Function 阶段统一模型适配器。 */
  functionDecisionAdapter: AsyncDecisionAdapter;
  /** Plugin 阶段统一模型适配器。 */
  pluginDecisionAdapter: AsyncDecisionAdapter;
};

/** 两阶段路由结果，永远不代表已执行插件。 */
export type RouteResult = {
  /** 稳定的路由终态。 */
  status: 'matched' | 'needs_clarification' | 'rejected' | 'noul';
  /** 可回放和监控使用的稳定原因。 */
  reasonCode: string;
  /** Function 阶段选择。 */
  functionId?: string;
  /** Plugin 阶段选择。 */
  pluginId?: string;
  /** Function 评估证据。 */
  functionEvaluation?: RuleEvaluationResult;
  /** Plugin 评估证据。 */
  pluginEvaluation?: RuleEvaluationResult;
  /** Function provider 的受控输出。 */
  functionDecision?: DecisionResult;
  /** Plugin provider 的受控输出。 */
  pluginDecision?: DecisionResult;
  /** 供下一轮意图识别使用的有界 Plugin/Action 范围。 */
  routingScope?: RoutingScope;
};

/**
 * Function-first 的受限两阶段路由器。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class TwoStageRouter {
  private readonly engine = new RuleEngine();
  /**
   * 先选择 Function，再选择其当前可用 Plugin 并完成最终重验证。
   *
   * @param request - 事实、规则、provider、宿主和授权边界
   * @returns 带两阶段证据的路由结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public route(request: RouteRequest): RouteResult {
    const functionEvaluation = this.engine.evaluateFunctions({ facts: request.facts, rules: request.functionRules });
    // Function 未形成可执行选择时，Plugin 阶段不可启动。
    if (functionEvaluation.status !== 'matched') return evaluationResult('function', functionEvaluation);
    const functionRequest = decisionRequest('function.select', functionEvaluation);
    const functionDecision = request.functionProvider.decide(functionRequest);
    // provider 不能把澄清、拒绝或 noul 伪装成路由选择。
    if (functionDecision.status !== 'choice' || !functionDecision.choice) {
      return decisionResult('function', functionEvaluation, functionDecision);
    }
    return this.routePlugin(request, functionEvaluation, functionDecision);
  }

  /**
   * 使用 UnifiedDecisionAdapter 执行异步 Function-first 路由，同时复用同步路由的所有最终门禁。
   * @param request - 带 trace/run 和 Function/Plugin 模型适配器的路由输入
   * @returns 与同步 route 相同的 RouteResult
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async routeAsync(request: AsyncRouteRequest): Promise<RouteResult> {
    const functionEvaluation = this.engine.evaluateFunctions({ facts: request.facts, rules: request.functionRules });
    // Function 未形成可执行选择时，异步模型和同步 provider 一样不能启动 Plugin。
    if (functionEvaluation.status !== 'matched') return evaluationResult('function', functionEvaluation);
    const functionRequest = decisionRequest('function.select', functionEvaluation);
    const functionDecision = await safeAsyncDecision(request.functionDecisionAdapter, request.traceId, request.runId, functionRequest, request.behaviorContext, request.currentMessage, request.recentMessages);
    if (functionDecision.status !== 'choice' || !functionDecision.choice) return decisionResult('function', functionEvaluation, functionDecision);
    return this.routePluginAsync(request, functionEvaluation, functionDecision);
  }

  /**
   * 在唯一 Function choice 下评估插件并执行最终门禁。
   *
   * @param request - 两阶段路由输入
   * @param functionEvaluation - 已完成的 Function 规则证据
   * @param functionDecision - 已校验的 Function choice
   * @returns 带 Function 和 Plugin 证据的路由结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private routePlugin(request: RouteRequest, functionEvaluation: RuleEvaluationResult, functionDecision: DecisionResult): RouteResult {
    const functionId = functionDecision.choice as string;
    const records = request.pluginHost.candidates(functionId);
    const candidates = authorizeCandidates(request, records);
    const pluginEvaluation = this.engine.evaluatePlugins({ facts: request.facts, functionId, candidates, rules: request.pluginRules });
    // Plugin 没有规则和宿主共同认可的候选时必须 fail-closed。
    if (pluginEvaluation.status !== 'matched') return { ...evaluationResult('plugin', pluginEvaluation), functionId, functionEvaluation, functionDecision, pluginEvaluation };
    const pluginDecision = request.pluginProvider.decide(decisionRequest('plugin.select', pluginEvaluation, records, functionId));
    // Plugin provider 的非 choice 不能产生 matched 路由。
    if (pluginDecision.status !== 'choice' || !pluginDecision.choice) return { status: routeStatus(pluginDecision.status), reasonCode: `plugin_${pluginDecision.status}`, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision };
    return finalizePluginRoute({ request, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision });
  }

  /** 使用统一异步模型适配器选择 Plugin，并复用同一候选和最终授权边界。 @param request - 异步路由输入 @param functionEvaluation - Function 规则证据 @param functionDecision - Function 统一决策 @returns 异步路由结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private async routePluginAsync(request: AsyncRouteRequest, functionEvaluation: RuleEvaluationResult, functionDecision: DecisionResult): Promise<RouteResult> {
    const functionId = functionDecision.choice as string;
    const records = request.pluginHost.candidates(functionId);
    const candidates = authorizeCandidates(request, records);
    const pluginEvaluation = this.engine.evaluatePlugins({ facts: request.facts, functionId, candidates, rules: request.pluginRules });
    // Plugin 候选为空时保持同步路由的 fail-closed 语义。
    if (pluginEvaluation.status !== 'matched') return { ...evaluationResult('plugin', pluginEvaluation), functionId, functionEvaluation, functionDecision, pluginEvaluation };
    const pluginRequest = decisionRequest('plugin.select', pluginEvaluation, records, functionId);
    const pluginDecision = await safeAsyncDecision(request.pluginDecisionAdapter, request.traceId, request.runId, pluginRequest, request.behaviorContext, request.currentMessage, request.recentMessages);
    if (pluginDecision.status !== 'choice' || !pluginDecision.choice) return { status: routeStatus(pluginDecision.status), reasonCode: `plugin_${pluginDecision.status}`, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision };
    return finalizePluginRoute({ request, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision });
  }
}

/**
 * Plugin-first 的受限路由器。
 *
 * 该路由器先把当前可用且被规则命中的 Plugin 描述交给模型，再把已选 Plugin
 * 的唯一 Function 作为二级候选。它不会先构造跨 Plugin 的 Function 候选集合。
 */
export class PluginFirstRouter {
  private readonly engine = new RuleEngine();

  /** 执行 Plugin-first → Function-secondary 的异步路由。 */
  public async routeAsync(request: AsyncRouteRequest): Promise<RouteResult> {
    const records = filterRecordsByActionType(request.pluginHost.businessCandidates(), request.facts);
    const functionIdsByPlugin = new Map(records.map((record) => [record.manifest.pluginId, functionIdsForAction(record, request.facts)]));
    const authorized = authorizeCandidates(request, records, (record) => selectPluginRuleFunction(record, request.pluginRules) ?? functionIdsByPlugin.get(record.manifest.pluginId)?.[0] ?? '');
    const pluginEvaluation = evaluatePluginScope(this.engine, request.facts, authorized, request.pluginRules);
    if (pluginEvaluation.status === 'no_match' || pluginEvaluation.candidates.length === 0) {
      return evaluationResult('plugin', pluginEvaluation);
    }
    const pluginDecision = await safeAsyncDecision(
      request.pluginDecisionAdapter,
      request.traceId,
      request.runId,
      decisionRequest('plugin.select', pluginEvaluation, records, undefined, (record) => selectPluginRuleFunction(record, request.pluginRules) ?? functionIdsByPlugin.get(record.manifest.pluginId)?.[0]),
      request.behaviorContext,
      request.currentMessage,
      request.recentMessages
    );
    if (pluginDecision.status !== 'choice' || !pluginDecision.choice) {
      return { status: routeStatus(pluginDecision.status), reasonCode: `plugin_${pluginDecision.status}`, pluginEvaluation, pluginDecision };
    }
    const selected = records.find((record) => record.manifest.pluginId === pluginDecision.choice);
    if (!selected || selected.manifest.pluginKind !== 'business') {
      return rejectedResult({ functionId: '', functionEvaluation: emptyFunctionEvaluation(), functionDecision: emptyFunctionDecision(''), pluginEvaluation, pluginDecision, reasonCode: 'plugin_unavailable' });
    }
    const functionIds = functionIdsByPlugin.get(selected.manifest.pluginId) ?? [];
    const functionId = functionIds[0];
    if (!functionId) {
      return rejectedResult({ functionId: '', functionEvaluation: emptyFunctionEvaluation(), functionDecision: emptyFunctionDecision(''), pluginEvaluation, pluginDecision, reasonCode: 'plugin_unavailable' });
    }
    const functionEvaluation = functionSelectionEvaluation(functionIds);
    const functionDecision = await safeAsyncDecision(
      request.functionDecisionAdapter,
      request.traceId,
      request.runId,
      decisionRequest('function.select', functionEvaluation),
      request.behaviorContext,
      request.currentMessage,
      request.recentMessages
    );
    if (functionDecision.status !== 'choice' || !functionDecision.choice || !functionIds.includes(functionDecision.choice)) {
      return { status: routeStatus(functionDecision.status), reasonCode: `function_${functionDecision.status}`, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision };
    }
    const selectedFunctionId = functionDecision.choice;
    const routingScope = buildRoutingScope(pluginEvaluation, selected, request.behaviorContext, selectedFunctionId);
    return finalizePluginRoute({ request, functionId: selectedFunctionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, routingScope });
  }
}

/**
 * 只按稳定的语义动作类型过滤插件能力；不解析业务关键词或历史原文。
 * 缺失/unknown 动作不会进入业务候选，交由上层回答模型处理。
 */
function filterRecordsByActionType(records: readonly PluginRecord[], facts: RuleEvaluationFacts): PluginRecord[] {
  const semantic = facts.semantic;
  const action = typeof semantic === 'object' && semantic !== null && !Array.isArray(semantic) ? (semantic as Record<string, unknown>).action : undefined;
  if (!isActionType(action)) return [];
  return records.filter((record) => record.manifest.pluginKind === 'business' && pluginFunctionIds(record).some((functionId) => record.functions.get(functionId)?.definition.actionTypes.includes(action)));
}

/** 返回 Plugin 内支持当前语义动作的 Function，保持注册顺序稳定。 */
function functionIdsForAction(record: PluginRecord, facts: RuleEvaluationFacts): string[] {
  const semantic = facts.semantic;
  const action = typeof semantic === 'object' && semantic !== null && !Array.isArray(semantic) ? (semantic as Record<string, unknown>).action : undefined;
  if (!isActionType(action) || record.manifest.pluginKind !== 'business') return [];
  return pluginFunctionIds(record).filter((functionId) => record.functions.get(functionId)?.definition.actionTypes.includes(action));
}

/** 选择 Plugin-first 阶段用于规则、授权和候选描述的 Function 归属。 */
function selectPluginRuleFunction(record: PluginRecord, rules: readonly PluginRule[]): string | undefined {
  if (record.manifest.pluginKind !== 'business') return undefined;
  return pluginFunctionIds(record).find((functionId) => rules.some((rule) => rule.pluginId === record.manifest.pluginId && rule.functionId === functionId));
}

/** 判断事实中的动作是否属于运行时固定协议。 */
function isActionType(value: unknown): value is ActionType {
  return ACTION_TYPES.includes(value as ActionType);
}

/**
 * 将宿主记录转为规则引擎的授权候选快照。
 *
 * @param request - 当前授权上下文和回调
 * @param records - PluginHost 当前 enabled business records
 * @returns 带授权状态和 Manifest capability 的候选快照
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function authorizeCandidates(request: RouteContext, records: readonly PluginRecord[], functionIdOf: (record: PluginRecord) => string = (record) => record.manifest.pluginKind === 'business' ? pluginFunctionIds(record)[0] ?? '' : '') {
  return records.map((record) => ({
    pluginId: record.manifest.pluginId,
    functionId: functionIdOf(record),
    enabled: true,
    authorized: request.authorizePlugin({ phase: 'candidate', ...requestContext(request, freezeRecordSnapshot(record)) }),
    capabilities: record.manifest.capabilities
  }));
}

/**
 * 重新解析最终插件并验证授权、归属和 Manifest capabilities。
 *
 * @param input - 当前路由上下文和两阶段证据
 * @returns 最终 matched 或稳定 rejected 结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function finalizePluginRoute(input: FinalizeRouteInput): RouteResult {
  const { request, functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision } = input;
  const pluginId = pluginDecision.choice as string;
  const resolved = request.pluginHost.resolveCandidate(functionId, pluginId);
  // provider choice 必须重新通过 PluginHost 当前状态和 ownership 门禁。
  if (!resolved.ok) {
    const reasonCode = resolved.error.code === ERROR_CODES.PLUGIN_OWNERSHIP_MISMATCH ? 'plugin_ownership_mismatch' : 'plugin_unavailable';
    return rejectedResult({ functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, reasonCode });
  }
  // 候选阶段通过授权不代表最终选择阶段仍然授权。
  const finalRecord = freezeRecordSnapshot(resolved.value);
  if (!request.authorizePlugin({ phase: 'selected', ...requestContext(request, finalRecord) })) return rejectedResult({ functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, reasonCode: 'unauthorized_plugin' });
  const rule = selectedPluginRule({ evaluation: pluginEvaluation, rules: request.pluginRules, functionId, pluginId });
  // 最终 choice 必须仍由当前 Function 的 PluginRule 约束。
  if (!rule) return rejectedResult({ functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, reasonCode: 'plugin_rule_missing' });
  // 能力只来自重新读取的 Manifest，provider 不能补充权限。
  if (!hasCapabilities(finalRecord, rule.requiredCapabilities)) return rejectedResult({ functionId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, reasonCode: 'missing_capability' });
  return matchedResult({ functionId, pluginId, functionEvaluation, functionDecision, pluginEvaluation, pluginDecision, ...(input.routingScope ? { routingScope: input.routingScope } : {}) });
}

/**
 * 构造授权 callback 的最小上下文。
 *
 * @param request - 当前租户、actor 和 environment
 * @param record - 当前宿主记录
 * @returns 授权输入中可复用的上下文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function requestContext(request: RouteContext, record: PluginRecord) {
  return { tenantId: request.tenantId, actorId: request.actorId, environment: request.environment, record };
}

/**
 * 复制并冻结授权 callback 可见的宿主记录。
 *
 * @param record - PluginHost 已返回的记录快照
 * @returns 不允许 callback 反向修改的记录投影
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function freezeRecordSnapshot(record: PluginRecord): PluginRecord {
  const manifest = { ...record.manifest, capabilities: [...record.manifest.capabilities], dependencies: [...record.manifest.dependencies] };
  return deepFreeze({ ...record, manifest });
}

/**
 * 递归冻结授权边界中的对象和数组。
 *
 * @param value - 待冻结的记录投影
 * @returns 同一引用的深度冻结值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value);
}

/**
 * 构造绑定当前候选集合的 DecisionRequest。
 *
 * @param decisionType - Function 或 Plugin 选择阶段
 * @param evaluation - 规则引擎输出
 * @returns provider 只能消费的有限候选请求
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function decisionRequest(decisionType: DecisionRequest['decisionType'], evaluation: RuleEvaluationResult, records?: readonly PluginRecord[], functionId?: string, functionIdOf?: (record: PluginRecord) => string | undefined): DecisionRequest {
  const recordsById = new Map((records ?? []).map((record) => [record.manifest.pluginId, record]));
  return { decisionType, decisionVersion: DECISION_VERSION, threshold: DECISION_THRESHOLD, candidates: evaluation.candidates.map((candidate) => toDecisionCandidate(candidate, recordsById.get(candidate.candidateId), functionId ?? functionIdOf?.(recordsById.get(candidate.candidateId)!))) };
}

/** 解包 UnifiedDecisionAdapter 结果；模型 gateway 失败收敛为既有 provider_failed 决策，不暴露 provider 错误。 @param adapter - 异步决策适配器 @param traceId - 链路标识 @param runId - 运行标识 @param request - 有限候选请求 @returns 稳定 DecisionResult @author lvdaxianer@yeah.net @date 2026-10-17 */
async function safeAsyncDecision(adapter: AsyncDecisionAdapter, traceId: string, runId: string, request: DecisionRequest, behaviorContext?: BehaviorContext, currentMessage?: string, recentMessages?: Array<{ role: string; text: string }>): Promise<DecisionResult> {
  try {
    const result = await adapter.decide({ traceId, runId, request, ...(currentMessage === undefined ? {} : { currentMessage }), ...(behaviorContext === undefined ? {} : { behaviorContext }), ...(recentMessages === undefined ? {} : { recentMessages }) });
    return result.ok ? result.value : providerFailureResult(request);
  } catch {
    // 适配器异常不能绕过路由的 DecisionResult 边界或进入公开错误正文。
    return providerFailureResult(request);
  }
}

/**
 * 将规则候选证据投影成不带权限的 DecisionCandidate。
 *
 * @param candidate - 规则引擎候选证据
 * @returns provider 输入候选
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function toDecisionCandidate(candidate: RuleEvaluationResult['candidates'][number], record?: PluginRecord, functionId?: string): DecisionCandidate {
  const base: DecisionCandidate = { candidateId: candidate.candidateId, priority: candidate.priority, specificity: candidate.specificity, requiredSlots: candidate.requiredSlots, evidenceCodes: candidate.evidenceCodes };
  if (record?.manifest.pluginKind === 'business') {
    const functionRecord = functionId ? record.functions.get(functionId) : undefined;
    if (!functionRecord) return base;
    base.description = record.manifest.description;
    base.functionId = functionId!;
    base.actionTypes = [...functionRecord.definition.actionTypes];
  }
  // 未声明风险等级时不伪造 provider 解释元数据。
  if (candidate.riskLevel === undefined) return base;
  return { ...base, riskLevel: candidate.riskLevel };
}

/**
 * 找到最终 choice 对应的当前 Function PluginRule。
 *
 * @param input - 已命中的评估、规则和两个候选标识
 * @returns 匹配规则或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function selectedPluginRule(input: { evaluation: RuleEvaluationResult; rules: readonly PluginRule[]; functionId: string; pluginId: string }) {
  const matched = input.evaluation.matchedRules.some((item) => item.candidateId === input.pluginId);
  return matched ? input.rules.find((rule) => rule.pluginId === input.pluginId && rule.functionId === input.functionId) : undefined;
}

/**
 * 检查最终 Manifest 是否覆盖规则声明的全部能力。
 *
 * @param record - PluginHost 最终重验证记录
 * @param requiredCapabilities - PluginRule 最小能力集合
 * @returns 是否满足能力约束
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function hasCapabilities(record: PluginRecord, requiredCapabilities: readonly string[] | undefined): boolean {
  // 系统插件没有业务能力边界，不能成为最终路由目标。
  if (record.manifest.pluginKind !== 'business') return false;
  return (requiredCapabilities ?? []).every((capability) => record.manifest.capabilities.includes(capability));
}

/**
 * 将规则评估非 matched 状态映射为路由终态。
 *
 * @param stage - Function 或 Plugin
 * @param evaluation - 规则引擎结果
 * @returns 不启动后续阶段的稳定结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function evaluationResult(stage: 'function' | 'plugin', evaluation: RuleEvaluationResult): RouteResult {
  const status = evaluation.status === 'no_match' ? 'noul' : evaluation.status;
  return { status, reasonCode: `${stage}_${status}`, ...(stage === 'function' ? { functionEvaluation: evaluation } : { pluginEvaluation: evaluation }) };
}

/**
 * 将 Function 决策非 choice 状态映射为路由终态。
 *
 * @param stage - 当前决策阶段
 * @param evaluation - 当前规则证据
 * @param decision - 当前 provider 结果
 * @returns 不启动 Plugin 阶段的稳定结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function decisionResult(stage: 'function', evaluation: RuleEvaluationResult, decision: DecisionResult): RouteResult {
  return { status: routeStatus(decision.status), reasonCode: `${stage}_${decision.status}`, functionEvaluation: evaluation, functionDecision: decision };
}

/**
 * 将 DecisionResult 状态收敛到路由器的终态集合。
 *
 * @param status - provider 返回的状态
 * @returns 路由器可表达的状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function routeStatus(status: DecisionResult['status']): RouteResult['status'] {
  // choice 只会在最终化前被拦截，防御性映射为 rejected。
  if (status === 'choice') return 'rejected';
  return status === 'noul' ? 'noul' : status;
}

/**
 * 构造最终拒绝结果并保留全部决策证据。
 *
 * @param input - 两阶段证据和稳定拒绝原因
 * @returns rejected 路由结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function rejectedResult(input: RouteEvidence & { reasonCode: string }): RouteResult {
  return { status: 'rejected', ...input };
}

/**
 * 构造通过所有运行时边界的 matched 结果。
 *
 * @param input - 两阶段证据和最终 Plugin 标识
 * @returns 仅表示可进入后续 Policy/Action 阶段的路由结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchedResult(input: MatchedRouteInput): RouteResult {
  return { status: 'matched', reasonCode: 'route_matched', ...input };
}

/** 在不构造 Function 全局候选的前提下，合并各 Plugin 的规则证据。 */
function evaluatePluginScope(engine: RuleEngine, facts: RuleEvaluationFacts, candidates: readonly PluginCandidate[], rules: readonly PluginRule[]): RuleEvaluationResult {
  const evaluations = candidates.map((candidate) => engine.evaluatePlugins({
    facts,
    functionId: candidate.functionId,
    candidates: [candidate],
    rules: rules.filter((rule) => rule.pluginId === candidate.pluginId && rule.functionId === candidate.functionId)
  }));
  const matchedCandidates = evaluations.flatMap((evaluation) => evaluation.candidates);
  const matchedRules = evaluations.flatMap((evaluation) => evaluation.matchedRules);
  const excludedCandidates = evaluations.flatMap((evaluation) => evaluation.excludedCandidates);
  const conflicts = evaluations.flatMap((evaluation) => evaluation.conflicts);
  if (matchedCandidates.length === 0) return { status: 'no_match', candidates: [], matchedRules, excludedCandidates, conflicts };
  const top = [...matchedCandidates].sort((left, right) => right.priority - left.priority || right.specificity - left.specificity);
  const highest = top[0]!;
  const topIds = top.filter((candidate) => candidate.priority === highest.priority && candidate.specificity === highest.specificity).map((candidate) => candidate.candidateId);
  return {
    status: 'matched',
    ...(topIds.length === 1 ? { selectedCandidateId: topIds[0] } : {}),
    candidates: matchedCandidates,
    matchedRules,
    excludedCandidates,
    conflicts
  };
}

/** 为已选 Plugin 构造其动作范围内的 Function 二级候选。 */
function functionSelectionEvaluation(functionIds: readonly string[]): RuleEvaluationResult {
  return {
    status: 'matched',
    ...(functionIds.length === 1 ? { selectedCandidateId: functionIds[0] } : {}),
    candidates: functionIds.map((functionId) => ({ candidateId: functionId, priority: 100, specificity: 1, requiredSlots: [], evidenceCodes: ['plugin.selected'], matchedRuleIds: [] })),
    matchedRules: [],
    excludedCandidates: [],
    conflicts: []
  };
}

/** 构造未命中时使用的稳定 Function 决策证据。 */
function emptyFunctionEvaluation(): RuleEvaluationResult {
  return { status: 'no_match', candidates: [], matchedRules: [], excludedCandidates: [], conflicts: [] };
}

/** 构造稳定的 Function 非选择结果，避免错误分支读取未定义 choice。 */
function emptyFunctionDecision(functionId: string): DecisionResult {
  return {
    schemaVersion: 'iar.decision/v1',
    decisionType: 'function.select',
    decisionVersion: DECISION_VERSION,
    status: 'rejected',
    reasonCode: 'plugin_unavailable',
    candidateIds: functionId ? [functionId] : []
  };
}

/** 将当前 Plugin 选择投影为下一轮模型可读取的有限路由范围。 */
function buildRoutingScope(evaluation: RuleEvaluationResult, selected: PluginRecord, behaviorContext?: BehaviorContext, functionId?: string): RoutingScope {
  if (selected.manifest.pluginKind !== 'business') throw new Error('系统插件不能形成路由范围');
  const manifest = selected.manifest;
  const selectedFunctionId = functionId ?? pluginFunctionIds(selected)[0];
  const functionRecord = selectedFunctionId ? selected.functions.get(selectedFunctionId) : undefined;
  if (!selectedFunctionId || !functionRecord) throw new Error('Plugin 不包含路由目标 Function');
  const candidatePluginIds = evaluation.candidates.slice(0, MAX_ROUTING_SCOPE_PLUGINS).map((candidate) => candidate.candidateId);
  const continuation = behaviorContext?.routingScope?.activePluginId === manifest.pluginId ? 'reuse' : 'replace';
  return {
    activePluginId: manifest.pluginId,
    candidatePluginIds,
    actionTypes: [...functionRecord.definition.actionTypes],
    continuation
  };
}

/** 返回业务 Plugin 中按注册顺序稳定排列的 Function 标识。 */
function pluginFunctionIds(record: PluginRecord): string[] {
  return record.manifest.pluginKind === 'business' ? [...record.functions.keys()] : [];
}
