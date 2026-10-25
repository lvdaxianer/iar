/** 会话使用的无状态投影、动作和槽位辅助函数。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { ActionDefinition, BehaviorContext, JsonSchema, JsonValue, PluginOperation, SlotValue } from '@iar/contracts';
import { SELF_INTRODUCTION_FUNCTION_ID, type PluginDescriptor } from '@iar/plugins';
import type { SemanticActionType, SemanticFrame } from '@iar/runtime';
import type { FunctionCallProposal, RouteResult } from '@iar/runtime';
import type { RuleEvaluationFacts } from '@iar/runtime';
import type { PendingActionSummary, RouteEvidence } from './session-types.js';

const API_GATEWAY_FUNCTION_ID = 'api.gateway';
const GATEWAY_LIMIT_OPERATION = 'limit';
const GATEWAY_RATE_FACT_KEY = 'newLimit';
const RATE_DECIMAL_PLACES = 6;

/**
 * 从 provider 输出中读取 iar.response/v1 的 text 字段。
 *
 * @param raw - provider 原始输出
 * @returns 非空 text 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function readResponseText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw : undefined;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const text = (raw as { text?: unknown }).text;
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

/**
 * 把 SemanticFrame 摊平成规则引擎读取的 JSON facts。
 *
 * @param frame - 结构化语义帧
 * @returns 规则评估事实
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function buildFacts(frame: SemanticFrame): RuleEvaluationFacts {
  const semantic: Record<string, JsonValue> = {
    intent: frame.intent,
    confidence: frame.confidence,
    slots: frame.slots,
    references: frame.references
  };
  if (frame.pluginId !== undefined) semantic.pluginId = frame.pluginId;
  if (frame.action !== undefined) semantic.action = frame.action;
  return { semantic };
}

/**
 * 从路由结果和语义帧构造调试面板证据。
 *
 * @param route - 两阶段路由结果
 * @param frame - 结构化语义帧
 * @returns 路由证据摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function buildEvidence(route: RouteResult, frame: SemanticFrame): RouteEvidence {
  const evidence: RouteEvidence = {
    status: route.status,
    reasonCode: route.reasonCode,
    semanticIntent: frame.intent,
    semanticConfidence: frame.confidence
  };
  if (route.functionId !== undefined) evidence.functionId = route.functionId;
  if (route.pluginId !== undefined) evidence.pluginId = route.pluginId;
  if (route.functionDecision?.score !== undefined) evidence.functionScore = route.functionDecision.score;
  if (route.pluginDecision?.score !== undefined) evidence.pluginScore = route.pluginDecision.score;
  return evidence;
}

/**
 * 从语义槽位组装统一 Handler 输入 { operation, query, params }。
 *
 * operation 缺省时不在此处推断，交由 handler 端按 query 关键词确定默认
 * read 操作；槽位给出的 operation 若不在目标 Function 的操作目录中会被
 * 丢弃，避免确认策略与实际执行不一致。search 类操作必须有 query。
 *
 * @param functionId - 目标 Function
 * @param slots - 抽取到的槽位
 * @param userText - 用户原始输入
 * @param behaviorContext - 当前结构化上下文，action 类操作的缺省槽位从 verified 事实继承
 * @returns 插件输入或缺失槽位列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export type ActionInputBuildResult =
  | { input: JsonValue }
  | { missing: string[]; reasonCode: 'function_missing' | 'action_type_missing' | 'operation_missing' | 'query_missing' | 'increment_base_missing' | 'gateway_rate_missing'; expectedOperation?: string; actualOperation?: string }
  | { reasonCode: 'operation_conflict'; expectedOperation: string; actualOperation: string };

export function buildActionInput(functionId: string, slots: Record<string, JsonValue>, userText: string, actionType: SemanticActionType = 'unknown', behaviorContext?: BehaviorContext, operations: readonly PluginOperation[] = [], corroboratedOperation?: string): ActionInputBuildResult {
  if (functionId.trim().length === 0) return { missing: ['functionId'], reasonCode: 'function_missing' };
  const sameFunctionHistory = behaviorContext?.route.functionId === functionId;
  const historicalOperation = sameFunctionHistory ? behaviorContext?.slots.operation?.value : undefined;
  const currentOperation = stringSlot(slots, 'operation');
  const factOperation = [...(behaviorContext?.factHistory?.records ?? [])]
    .filter((record) => record.functionId === functionId)
    .reverse()
    .map((record) => record.values.operation)
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const verifiedHistoricalOperation = typeof historicalOperation === 'string' && historicalOperation.trim().length > 0
    ? historicalOperation.trim()
    : factOperation?.trim();
  const rawOperation = currentOperation ?? verifiedHistoricalOperation;
  // Action Handler 的 query 仍是统一协议中的原始补充文本，但在当前轮存在
  // 明确自我纠正时必须移除已撤回的旧值。否则下游只按 query 做通用解析时，
  // 可能把第一个数字误认为最终值。该处理只识别通用纠正结构，不读取业务词。
  const query = userText.length > 0 ? normalizeCorrectedActionQuery(userText) : stringSlot(slots, 'query');
  if (actionType === 'unknown') {
    const operation = chooseOperationWithoutActionType(operations, rawOperation, userText);
    if (operation === undefined) return { missing: ['operation'], reasonCode: 'operation_missing', expectedOperation: operations.map((item) => item.name).join('|').slice(0, 256), actualOperation: 'missing' };
    const input: Record<string, JsonValue> = { operation };
    if (query) input.query = query.slice(0, 500);
    const params = inheritFactParams(functionId, paramsSlot(slots), userText, behaviorContext);
    if (params) input.params = params;
    return { input };
  }
  const expectedKind = actionType === 'query' ? 'read' : 'action';
  const continuationOperation = functionId === API_GATEWAY_FUNCTION_ID && parseRateAdjustment(userText) !== undefined ? GATEWAY_LIMIT_OPERATION : currentOperation;
  const operation = chooseCompatibleOperation(operations, continuationOperation ?? verifiedHistoricalOperation, expectedKind, userText, actionType, verifiedHistoricalOperation, corroboratedOperation);
  const params = inheritFactParams(functionId, paramsSlot(slots), userText, behaviorContext);
  const adjusted = resolveIncrementalRate(functionId, params, userText, behaviorContext);
  if (adjusted.missing) return { missing: ['params'], reasonCode: 'increment_base_missing' };
  if (!operation) return { missing: ['operation'], reasonCode: 'operation_missing', expectedOperation: (operations.filter((item) => item.kind === expectedKind).map((item) => item.name).join('|') || 'unknown').slice(0, 256), actualOperation: 'missing' };
  // 限流动作必须携带一个明确的目标值或可计算的相对调整。模糊请求、范围
  // 和“你看着办”不能先进入高风险确认框，否则用户确认的其实是系统猜出的值。
  if (functionId === API_GATEWAY_FUNCTION_ID && operation === GATEWAY_LIMIT_OPERATION && requiresGatewayRateClarification(userText)) {
    return { missing: ['params'], reasonCode: 'gateway_rate_missing' };
  }
  if (operation === 'search' && !query) return { missing: ['query'], reasonCode: 'query_missing' };
  const input: Record<string, JsonValue> = {};
  input.operation = operation.slice(0, 60);
  if (query) input.query = query.slice(0, 500);
  if (adjusted.params) input.params = adjusted.params;
  return { input };
}

type IncrementalRateResult = { params?: Record<string, string>; missing?: boolean };

/**
 * 将网关限流的相对调整转换为基于最新可信事实的绝对值。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function resolveIncrementalRate(functionId: string, params: Record<string, string> | undefined, userText: string, context: BehaviorContext | undefined): IncrementalRateResult {
  // 非网关或已有明确 rate 时保留当前轮参数，不覆盖用户最新输入。
  if (functionId !== API_GATEWAY_FUNCTION_ID || params?.rate !== undefined) return params === undefined ? {} : { params };
  const adjustment = parseRateAdjustment(userText);
  // 没有相对表达时沿用原有参数构建流程。
  if (adjustment === undefined) return params === undefined ? {} : { params };
  const base = latestGatewayRate(context);
  // 缺少可信基线时拒绝猜测，避免把增量当作绝对值执行。
  if (base === undefined) return { missing: true };
  const delta = adjustment.percent ? base * adjustment.value / 100 : adjustment.value;
  const next = adjustment.direction === 'up' ? base + delta : base - delta;
  if (!Number.isFinite(next) || next < 0) return { missing: true };
  return { params: { ...(params ?? {}), rate: `${formatRate(next)}/s` } };
}

/**
 * 读取“上调/下调 N”或百分比表达，无法识别时保持原始输入。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function parseRateAdjustment(text: string): { direction: 'up' | 'down'; value: number; percent: boolean } | undefined {
  const match = text.match(/(上调|往上调|提高|增加|加上|下调|往下调|降低|减少|减去)\s*(\d+(?:\.\d+)?)\s*(%)?/u);
  // 未命中相对调整句式时不改变输入语义。
  if (match === null) return undefined;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return undefined;
  return { direction: /下调|往下调|降低|减少|减去/u.test(match[1]!) ? 'down' : 'up', value, percent: match[3] === '%' };
}

/** 判断限流请求是否给出了单一、可执行的目标值；范围和约束表达必须继续澄清。 */
export function requiresGatewayRateClarification(text: string): boolean {
  if (!/(限流|rate\s*limit)/iu.test(text) || !/(调整|调到|调低|调高|调一下|修改|设为|改成|提高|降低|上调|下调|提额)/iu.test(text)) return false;
  return parseRateAdjustment(text) === undefined && !hasExplicitGatewayRate(text);
}

function hasExplicitGatewayRate(text: string): boolean {
  const normalized = text.replace(/,/g, '');
  if (/(?:之间|范围|between|and)|\d\s*(?:到|至|[-~～])\s*\d|(?:不低于|不高于|至少|最多|不超过|别低于|别高于)/iu.test(normalized)) return false;
  const values = normalized.match(/\d+(?:\.\d+)?/g) ?? [];
  const chineseValues = (normalized.match(/[零〇一二两三四五六七八九十百千万亿]+/gu) ?? []).filter((value) => /[十百千万亿]/u.test(value));
  return values.length + chineseValues.length === 1;
}

/**
 * 从最新 api.gateway 事实中读取可用于相对调整的限流基线。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function latestGatewayRate(context: BehaviorContext | undefined): number | undefined {
  const records = context?.factHistory?.records ?? [];
  const record = [...records].reverse().find((item) => item.functionId === API_GATEWAY_FUNCTION_ID && typeof item.values[GATEWAY_RATE_FACT_KEY] === 'string');
  const value = record?.values[GATEWAY_RATE_FACT_KEY];
  const match = typeof value === 'string' ? value.match(/\d+(?:\.\d+)?/u) : null;
  // 事实缺失或格式非法时交由上层执行 fail-closed。
  return match === null ? undefined : Number(match[0]);
}

/**
 * 把计算结果规范化到有限的小数位，避免把浮点误差带入 Handler。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function formatRate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(RATE_DECIMAL_PLACES).replace(/0+$/u, '').replace(/\.$/u, '');
}

/** 将同一 Function 的已解析列表事实按字段名并入参数，当前轮槽位保持最高优先级。 */
export function mergeResolvedReferenceParams(slots: Record<string, JsonValue>, references: readonly import('./session-types.js').ResolvedContextReference[], functionId: string): Record<string, JsonValue> {
  const params = isRecord(slots.params) ? { ...slots.params } : {};
  for (const reference of references) {
    if (!('record' in reference)) continue;
    if (reference.record.functionId !== functionId) continue;
    for (const [field, value] of Object.entries(reference.record.values)) {
      if (typeof value === 'string' && value.length > 0 && !Object.hasOwn(params, field)) params[field] = value;
    }
  }
  return Object.keys(params).length > 0 ? { ...slots, params } : slots;
}

/**
 * 移除当前轮自我纠正表达中的旧字面值，保留目标对象和最终替代值。
 *
 * 只在同一文本包含多个数字且出现纠正/替换连接词时生效，避免改变普通
 * 查询和单值动作的原始语义。参数字段仍由 Semantic Frame/Schema 校验决定。
 */
function normalizeCorrectedActionQuery(text: string): string {
  const numbers = text.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numbers.length < 2) return text;
  const marker = /(?:不对|而是|改成|调到|设为|换成|变更为)/g;
  let lastMarker: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) lastMarker = match;
  if (lastMarker === null) return text;
  const before = text.slice(0, lastMarker.index).replace(/\d+(?:\.\d+)?/g, '');
  return `${before}${text.slice(lastMarker.index)}`.replace(/\s{2,}/g, ' ').trim();
}

/** 只把当前 Function Schema 已声明且已验证的上下文槽位作为补参基线。 */
export function mergeVerifiedFunctionSlots(slots: Record<string, JsonValue>, behaviorContext: BehaviorContext, schema: JsonSchema): Record<string, JsonValue> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const inherited: Record<string, JsonValue> = {};
  for (const [field, slot] of Object.entries(behaviorContext.slots)) {
    if ((slot.status === 'resolved' || slot.status === 'confirmed') && Object.hasOwn(properties, field)) inherited[field] = slot.value;
  }
  return mergeNamedJsonValues(inherited, slots);
}

/** 按字段名递归合并结构化参数，当前轮值覆盖上下文值。 */
function mergeNamedJsonValues(previous: Record<string, JsonValue>, incoming: Record<string, JsonValue>): Record<string, JsonValue> {
  const merged = { ...previous };
  for (const [field, value] of Object.entries(incoming)) {
    const previousValue = merged[field];
    if (isRecord(previousValue) && isRecord(value)) merged[field] = mergeNamedJsonValues(previousValue, value);
    else merged[field] = value;
  }
  return merged;
}

/** 判断值是否为可递归的 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 将 Function Calling 的已校验 arguments 转成唯一 Action 输入。 */
export function buildFunctionCallInput(proposal: FunctionCallProposal): ActionInputBuildResult {
  const input = structuredClone(proposal.arguments) as Record<string, JsonValue>;
  const declaredOperation = input.operation;
  if (declaredOperation !== undefined && declaredOperation !== proposal.operation) return { reasonCode: 'operation_conflict', expectedOperation: proposal.operation.slice(0, 256), actualOperation: String(declaredOperation).slice(0, 256) };
  input.operation = proposal.operation;
  return { input };
}

/** 构造内置自我介绍 Plugin 的受控能力清单输入。
 *
 * @param descriptors - 当前宿主可路由的能力描述
 * @param extraPrompt - Agent 创建时保存的额外提示词
 * @returns 自我介绍 Handler 的 JSON 输入
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
export function buildSelfIntroductionInput(descriptors: readonly PluginDescriptor[], extraPrompt?: string): JsonValue {
  const plugins = descriptors
    .filter((descriptor) => descriptor.functionId !== SELF_INTRODUCTION_FUNCTION_ID)
    .map(({ pluginId, functionId, description }) => ({ pluginId, functionId, description }));
  return { plugins, ...(extraPrompt === undefined ? {} : { extraPrompt }) };
}

/** 选择与固定语义动作类型兼容的操作目录项。 */
function chooseCompatibleOperation(operations: readonly PluginOperation[], rawOperation: string | undefined, expectedKind: 'read' | 'action', userText: string, actionType: SemanticActionType, verifiedFallbackOperation?: string, corroboratedOperation?: string): string | undefined {
  if (rawOperation) {
    const explicit = operations.find((item) => item.name === rawOperation);
    const compatible = operations.filter((item) => item.kind === expectedKind);
    const hasActionOperation = operations.some((item) => item.kind === 'action');
    if (explicit === undefined && expectedKind === 'read' && ((compatible.length === 1 && !hasActionOperation) || userText.trim().startsWith('candidate-'))) return compatible[0]?.name;
    if (explicit?.kind === expectedKind) {
      if (explicit.name === corroboratedOperation) return explicit.name;
      if (expectedKind === 'read' && userText.trim().startsWith('candidate-') && operations.every((item) => item.kind === 'read')) return explicit.name;
      if (expectedKind === 'read' && compatible.length === 1 && !hasActionOperation) return explicit.name;
      // Model-produced operation names are untrusted. A name may pass only
      // when the current text carries operation evidence, or when the
      // Function has exactly one compatible operation and therefore no
      // ambiguity exists.
      if (operationHasTextEvidence(explicit, userText, actionType)) {
        if (expectedKind === 'read' && operations.filter((item) => item.kind === 'read').length > 1) {
          const matched = matchOperationFromText(operations, userText, expectedKind, actionType);
          if (matched !== explicit.name) return undefined;
        }
        return explicit.name;
      }
    }
    const matched = expectedKind === 'action' ? matchOperationFromText(operations, userText, expectedKind, actionType) : undefined;
    if (matched !== undefined) return matched;
    const verifiedFallback = operations.find((item) => item.name === verifiedFallbackOperation && item.kind === expectedKind);
    if (verifiedFallback !== undefined && (expectedKind === 'action' || operations.filter((item) => item.kind === expectedKind).length === 1)) return verifiedFallback.name;
    return undefined;
  }
  if (expectedKind === 'action') return undefined;
  const compatible = operations.filter((item) => item.kind === expectedKind);
  const textMatch = matchOperationFromText(operations, userText, expectedKind, actionType);
  if (textMatch !== undefined) return textMatch;
  if (expectedKind === 'read' && userText.trim().startsWith('candidate-') && compatible.length > 0) return compatible[0]?.name;
  return compatible.length === 1 && !operations.some((item) => item.kind === 'action') ? compatible[0]?.name : undefined;
}

/** action 未分类时只接受当前文本明确支持的唯一 Operation，不猜测读写类型。 */
function chooseOperationWithoutActionType(operations: readonly PluginOperation[], rawOperation: string | undefined, userText: string): string | undefined {
  if (rawOperation !== undefined) {
    const explicit = operations.find((item) => item.name === rawOperation);
    if (explicit !== undefined && (operations.length === 1 || operationHasTextEvidence(explicit, userText))) return explicit.name;
  }
  const matches = operations.filter((operation) => operationHasTextEvidence(operation, userText));
  if (userText.trim().startsWith('candidate-') && operations.length > 0 && operations.every((operation) => operation.kind === 'read')) return operations[0]?.name;
  return matches.length === 1 ? matches[0]!.name : undefined;
}

/** 在已验证的 Operation 描述中寻找当前轮的唯一动作表达，不创建新的操作标识。 */
function matchOperationFromText(operations: readonly PluginOperation[], userText: string, expectedKind: 'read' | 'action', actionType?: SemanticActionType): string | undefined {
  const compatible = operations.filter((operation) => operation.kind === expectedKind);
  const ranked = rankOperationTextEvidence(compatible, userText, actionType);
  const first = ranked[0];
  const second = ranked[1];
  return first !== undefined && first.score > 0 && (second === undefined || second.score < first.score) ? first.operation.name : undefined;
}

/** 在同一 Operation 目录内只使用唯一描述词面，忽略跨 Operation 共享领域词。 */
function rankOperationTextEvidence(operations: readonly PluginOperation[], userText: string, actionType?: SemanticActionType): Array<{ operation: PluginOperation; score: number }> {
  const text = userText.trim().toLocaleLowerCase();
  const featureSets = operations.map((operation) => operationTextFeatures(operation));
  const frequency = new Map<string, number>();
  for (const features of featureSets) for (const feature of features) frequency.set(feature, (frequency.get(feature) ?? 0) + 1);
  return operations.map((operation, index) => {
    const features = featureSets[index] ?? new Set<string>();
    const uniqueScore = [...features].filter((feature) => frequency.get(feature) === 1 && text.includes(feature)).reduce((total, feature) => total + feature.length, 0);
    const exactNameScore = text.includes(operation.name.toLocaleLowerCase()) ? operation.name.length * 10 : 0;
    const actionScore = actionType !== undefined && operation.name.toLocaleLowerCase() === actionType && actionTypeTextEvidence(actionType, text) ? 1 : 0;
    const fallbackScore = operationHasTextEvidence(operation, userText, actionType) ? 1 : 0;
    return { operation, score: exactNameScore + uniqueScore + actionScore + fallbackScore };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
}

/** 提取 Operation 描述中的中英文词面，完全由声明内容驱动。 */
function operationTextFeatures(operation: PluginOperation): Set<string> {
  const description = typeof operation.description === 'string' ? operation.description : '';
  const leading = description.match(/^(?:[\p{Script=Han}]{2,4}|[a-z][a-z0-9_-]{1,30})/iu)?.[0]?.toLocaleLowerCase();
  const body = description.replace(/^(?:查看|检索|查询|列出|获取|调整|修改|设置|提交|创建|导出|重跑|停止|转接|申请|删除|执行|运行)/u, '');
  const normalized = body.toLocaleLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/giu, '');
  const features = new Set<string>();
  if (leading !== undefined) {
    const leadingFeature = /^[\p{Script=Han}]{2}/u.exec(leading)?.[0] ?? leading;
    if (leadingFeature.length > 0) features.add(leadingFeature);
  }
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const feature = normalized.slice(index, index + 2);
    if (/^[\p{Script=Han}]{2}$/u.test(feature)) features.add(feature);
  }
  const operationName = operation.name.toLocaleLowerCase();
  if (operationName.length > 0) features.add(operationName);
  return features;
}

/** 只从当前用户文本提取 Operation 的通用词面证据，不解释业务领域。 */
export function operationHasTextEvidence(operation: PluginOperation, userText: string, actionType?: SemanticActionType): boolean {
  const text = userText.trim().toLocaleLowerCase();
  const name = operation.name.trim().toLocaleLowerCase();
  if (name.length > 0 && text.includes(name)) return true;
  if (actionType !== undefined && operation.name.trim().toLocaleLowerCase() === actionType && actionTypeTextEvidence(actionType, text)) return true;
  // Operation 描述通常以可操作的短语开头；仅接受开头的有限短语，避免
  // 把 Function 的领域名词误当成 Operation 选择依据。
  const description = typeof operation.description === 'string' ? operation.description : '';
  const leadingMatch = description.match(/^(?:[\p{Script=Han}]{2,4}|[a-z][a-z0-9_-]{1,30})/iu)?.[0]?.toLocaleLowerCase();
  if (leadingMatch === undefined) return false;
  if (/^[\p{Script=Han}]+$/u.test(leadingMatch)) {
    if (Array.from({ length: leadingMatch.length - 1 }, (_, index) => leadingMatch.slice(0, index + 2)).some((prefix) => text.includes(prefix))) return true;
  }
  if (operation.kind === 'read' && readOperationVerbEvidence(leadingMatch, text)) return true;
  if (operation.kind === 'action' || (operation.kind === 'read' && QUERY_OPERATION_TEXT_PATTERN.test(text))) {
    const body = description.replace(/^(?:查看|检索|查询|列出|获取|调整|修改|设置|提交|创建|导出|重跑|停止|转接|申请|删除|执行|运行)/u, '');
    const normalizedBody = body.replace(/[^\p{Script=Han}a-z0-9]+/giu, '');
    const tokens = Array.from({ length: Math.max(0, normalizedBody.length - 1) }, (_, index) => normalizedBody.slice(index, index + 2)).filter((token) => /[\p{Script=Han}]{2}/u.test(token));
    if (tokens.some((token) => text.includes(token))) return true;
  }
  return text.includes(leadingMatch);
}

/** 只把明确的查询表达作为 read Operation 的词面证据。 */
const QUERY_OPERATION_TEXT_PATTERN = /(?:查看|看看|看下|有哪些|是什么|多少|列出|查询|检索|搜索|查|list|search|what|which|how\s+many)/iu;

/** 将用户常见的查询动词变体映射到 Operation 描述的开头动词。 */
function readOperationVerbEvidence(leading: string, text: string): boolean {
  const aliases: Record<string, RegExp> = {
    查看: /查看|看看|看下|看一眼/iu,
    列出: /列出|列一下|罗列/iu,
    检索: /检索|搜索|搜一下/iu,
    查询: /查询|查一下|查下|查查/iu,
    获取: /获取|拿到/iu,
    list: /\blist\b/iu,
    search: /\bsearch\b/iu,
    query: /\bquery\b/iu
  };
  return aliases[leading]?.test(text) ?? false;
}

/** 判断用户是否要求绕过操作描述中声明的确认、审批或校验边界。 */
export function operationHasContradictoryPolicyText(operation: PluginOperation, userText: string): boolean {
  const description = operation.description.toLocaleLowerCase();
  const text = userText.toLocaleLowerCase();
  return /(?:不走|绕过|跳过|无需|不用|免于|直接)/u.test(text)
    && /(?:确认|审批|授权|校验|验证|审计)/u.test(description);
}

/** 校验用户提供的格式/枚举值是否出现在 Operation 的公开描述中。 */
export function operationHasUnsupportedArgument(operation: PluginOperation, userText: string): boolean {
  const allowed = operation.description.match(/[a-z][a-z0-9.+-]{1,20}/giu)?.map((value) => value.toLocaleLowerCase()) ?? [];
  const requested = userText.match(/(?:成|为|用|格式|format)\s*([a-z][a-z0-9.+-]{1,20})/iu)?.[1]?.toLocaleLowerCase();
  return requested !== undefined && allowed.length > 0 && !allowed.includes(requested);
}

/** 仅对协议动作类型提供通用自然语言证据，不绑定任何业务 Function。 */
function actionTypeTextEvidence(actionType: SemanticActionType, text: string): boolean {
  const patterns: Partial<Record<SemanticActionType, RegExp>> = {
    create: /创建|新建|新增|提交/u,
    update: /更新|修改|调整|调到|调成|调低|调高|设置|设为|改成|上调|下调|提高|降低|增加|减少|申请|提交|开通|提权/u,
    delete: /删除|移除|清除/u,
    transfer: /转接|转人工|移交/u,
    execute: /执行|运行|重跑|重新跑|导出|停止|暂停/u
  };
  return patterns[actionType]?.test(text) ?? false;
}

/**
 * 从结构化上下文的 verified 事实为 action 类操作继承缺省槽位。
 *
 * 用户在多轮对话中用「改成/那个」指代上一轮对象时，语义层可能漏抽 params；
 * 此处按 functionId + operation 做确定性回填（如 api.gateway limit 的 target、
 * ticket.create progress 的 ticketId），只读操作不做继承，避免事实污染查询。
 *
 * @param functionId - 目标 Function
 * @param operation - 生效操作名
 * @param params - 语义层给出的槽位（可能为 undefined）
 * @param behaviorContext - 当前结构化上下文
 * @returns 继承后的槽位（无事实可继承时原样返回）
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
function inheritFactParams(functionId: string, params: Record<string, string> | undefined, currentText: string, behaviorContext: BehaviorContext | undefined): Record<string, string> | undefined {
  const inherited = { ...(params ?? {}) };
  const records = behaviorContext?.factHistory?.records ?? [];
  for (const record of [...records].reverse()) {
    if (record.functionId !== functionId) continue;
    for (const [field, value] of Object.entries(record.values)) {
      if (field === 'operation') continue;
      if (inherited[field] || typeof value !== 'string' || value.length === 0) continue;
      // 当前轮的自然语言可能只携带了新值，语义模型未必会把它重复映射到
      // params。数字事实出现不同的新值时，旧事实不能继续覆盖当前输入。
      if (hasDifferentNumericValue(currentText, value)) continue;
      inherited[field] = value;
    }
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined;
}

/** 判断当前文本是否携带了与历史字符串不同的数字值。 */
function hasDifferentNumericValue(currentText: string, historicalValue: string): boolean {
  const currentNumbers: string[] = currentText.match(/\d+(?:\.\d+)?/g) ?? [];
  const historicalNumbers: string[] = historicalValue.match(/\d+(?:\.\d+)?/g) ?? [];
  if (currentNumbers.length === 0 || historicalNumbers.length === 0) return false;
  return currentNumbers.some((current) => !historicalNumbers.includes(current));
}

/**
 * 按操作 kind 判定确认策略：action 沿用 manifest 上限，read 免确认。
 *
 * @param functionId - 目标 Function
 * @param input - 已构建的 Handler 输入
 * @returns 操作类型，未知 Function 按 action 保守处理
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function sandboxOperationKind(functionId: string, input: JsonValue, operations: readonly PluginOperation[] = []): 'read' | 'action' {
  if (functionId.trim().length === 0) return 'action';
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, JsonValue> : {};
  const raw = record.operation;
  if (typeof raw === 'string' && raw.length > 0) {
    return operations.find((item) => item.name === raw)?.kind ?? 'read';
  }
  return operations.find((item) => item.kind === 'read')?.kind ?? 'action';
}

/**
 * 用中文子系统名与操作名描述待确认动作，供确认提示展示。
 *
 * @param action - 待确认动作
 * @returns 人类可读的动作描述
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function describeAction(action: ActionDefinition, descriptor?: { description: string; operations?: readonly PluginOperation[] }): string {
  const record = typeof action.input === 'object' && action.input !== null && !Array.isArray(action.input) ? action.input as Record<string, JsonValue> : {};
  const operation = typeof record.operation === 'string' && record.operation.length > 0 ? record.operation : undefined;
  const name = descriptor?.description ?? action.functionId;
  return operation ? `${name} · ${operation}` : name;
}

/**
 * 读取字符串槽位。
 *
 * @param slots - 槽位集合
 * @param key - 槽位名
 * @returns 非空字符串或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function stringSlot(slots: Record<string, JsonValue>, key: string): string | undefined {
  const value = slots[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 读取字符串键值 params 槽位，非法结构返回 undefined。
 *
 * @param slots - 槽位集合
 * @returns 键值均为非空字符串的映射，或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function paramsSlot(slots: Record<string, JsonValue>): Record<string, string> | undefined {
  const value = slots.params;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const params: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, JsonValue>)) {
    if (typeof item !== 'string' || item.trim().length === 0) return undefined;
    params[key] = item.trim().slice(0, 200);
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * 把语义槽位转换成 BehaviorContext 的 SlotValue 映射。
 *
 * @param slots - 语义槽位
 * @returns 带 resolved 状态的槽位映射
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function toSlotMap(slots: Record<string, JsonValue>): Record<string, SlotValue> {
  return Object.fromEntries(Object.entries(slots).map(([key, value]) => [key, { value, status: 'resolved' as const }]));
}

/**
 * 构造待确认动作摘要。
 *
 * @param action - 完整 Action
 * @returns 摘要对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function summarizeAction(action: ActionDefinition): PendingActionSummary {
  return {
    actionId: action.actionId,
    runId: action.runId,
    functionId: action.functionId,
    pluginId: action.pluginId,
    riskLevel: action.riskLevel,
    confirmationRequired: action.confirmationRequired,
    input: action.input
  };
}
