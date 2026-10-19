/** 会话使用的无状态投影、动作和槽位辅助函数。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { ActionDefinition, JsonValue, SlotValue } from '@iar/contracts';
import type { SemanticActionType, SemanticFrame } from '@iar/decision';
import type { RouteResult } from '@iar/runtime';
import type { RuleEvaluationFacts } from '@iar/rule-engine';
import { sandboxFunctionCatalog } from './functions/index.js';
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
 * @returns 插件输入或缺失槽位列表
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function buildActionInput(functionId: string, slots: Record<string, JsonValue>, userText: string, actionType: SemanticActionType = 'unknown'): { input: JsonValue } | { missing: string[] } {
  const descriptor = sandboxFunctionCatalog[functionId];
  if (!descriptor) return { missing: [`未知 Function: ${functionId}`] };
  if (actionType === 'unknown') return { missing: ['actionType'] };
  const rawOperation = stringSlot(slots, 'operation');
  const query = stringSlot(slots, 'query') ?? (userText.length > 0 ? userText : undefined);
  const expectedKind = actionType === 'query' ? 'read' : 'action';
  const operation = chooseCompatibleOperation(descriptor, rawOperation, expectedKind);
  const params = paramsSlot(slots);
  if (!operation) return { missing: ['operation'] };
  if (operation === 'search' && !query) return { missing: ['query'] };
  const input: Record<string, JsonValue> = {};
  input.operation = operation.slice(0, 60);
  if (query) input.query = query.slice(0, 500);
  if (params) input.params = params;
  return { input };
}

/** 选择与固定语义动作类型兼容的操作目录项。 */
function chooseCompatibleOperation(descriptor: { operations: ReadonlyArray<{ name: string; kind: string }> }, rawOperation: string | undefined, expectedKind: 'read' | 'action'): string | undefined {
  if (rawOperation) {
    const explicit = descriptor.operations.find((item) => item.name === rawOperation);
    if (explicit?.kind === expectedKind) return explicit.name;
    return undefined;
  }
  if (expectedKind === 'action') return undefined;
  return descriptor.operations.find((item) => item.kind === expectedKind)?.name;
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
export function sandboxOperationKind(functionId: string, input: JsonValue): 'read' | 'action' {
  const descriptor = sandboxFunctionCatalog[functionId];
  if (!descriptor) return 'action';
  const record = typeof input === 'object' && input !== null && !Array.isArray(input) ? input as Record<string, JsonValue> : {};
  const raw = record.operation;
  if (typeof raw === 'string' && raw.length > 0) {
    return descriptor.operations.find((item) => item.name === raw)?.kind ?? 'read';
  }
  const name = descriptor.defaultOperation;
  return descriptor.operations.find((item) => item.name === name)?.kind ?? 'read';
}

/**
 * 用中文子系统名与操作名描述待确认动作，供确认提示展示。
 *
 * @param action - 待确认动作
 * @returns 人类可读的动作描述
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export function describeAction(action: ActionDefinition): string {
  const descriptor = sandboxFunctionCatalog[action.functionId];
  const record = typeof action.input === 'object' && action.input !== null && !Array.isArray(action.input) ? action.input as Record<string, JsonValue> : {};
  const operation = typeof record.operation === 'string' && record.operation.length > 0 ? record.operation : descriptor?.defaultOperation;
  const name = descriptor?.name ?? action.functionId;
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
