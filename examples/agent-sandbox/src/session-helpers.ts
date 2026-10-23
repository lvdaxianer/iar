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
  | { missing: string[]; reasonCode: 'function_missing' | 'action_type_missing' | 'operation_missing' | 'query_missing'; expectedOperation?: string; actualOperation?: string }
  | { reasonCode: 'operation_conflict'; expectedOperation: string; actualOperation: string };

export function buildActionInput(functionId: string, slots: Record<string, JsonValue>, userText: string, actionType: SemanticActionType = 'unknown', behaviorContext?: BehaviorContext, operations: readonly PluginOperation[] = []): ActionInputBuildResult {
  if (functionId.trim().length === 0) return { missing: ['functionId'], reasonCode: 'function_missing' };
  if (actionType === 'unknown') return { missing: ['actionType'], reasonCode: 'action_type_missing' };
  const rawOperation = stringSlot(slots, 'operation');
  const query = userText.length > 0 ? userText : stringSlot(slots, 'query');
  const expectedKind = actionType === 'query' ? 'read' : 'action';
  const operation = chooseCompatibleOperation(operations, rawOperation, expectedKind);
  const params = inheritFactParams(functionId, paramsSlot(slots), behaviorContext);
  if (!operation) return { missing: ['operation'], reasonCode: 'operation_missing', expectedOperation: (operations.filter((item) => item.kind === expectedKind).map((item) => item.name).join('|') || 'unknown').slice(0, 256), actualOperation: 'missing' };
  if (operation === 'search' && !query) return { missing: ['query'], reasonCode: 'query_missing' };
  const input: Record<string, JsonValue> = {};
  input.operation = operation.slice(0, 60);
  if (query) input.query = query.slice(0, 500);
  if (params) input.params = params;
  return { input };
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
function chooseCompatibleOperation(operations: readonly PluginOperation[], rawOperation: string | undefined, expectedKind: 'read' | 'action'): string | undefined {
  if (rawOperation) {
    const explicit = operations.find((item) => item.name === rawOperation);
    if (explicit?.kind === expectedKind) return explicit.name;
    return undefined;
  }
  if (expectedKind === 'action') return undefined;
  return operations.find((item) => item.kind === expectedKind)?.name;
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
function inheritFactParams(functionId: string, params: Record<string, string> | undefined, behaviorContext: BehaviorContext | undefined): Record<string, string> | undefined {
  const inherited = { ...(params ?? {}) };
  const records = behaviorContext?.factHistory?.records ?? [];
  for (const record of [...records].reverse()) {
    if (record.functionId !== functionId) continue;
    for (const [field, value] of Object.entries(record.values)) {
      if (inherited[field] || typeof value !== 'string' || value.length === 0) continue;
      inherited[field] = value;
    }
  }
  return Object.keys(inherited).length > 0 ? inherited : undefined;
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
