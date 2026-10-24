/**
 * 定义 IAR 与 Pi 扩展之间的版本化 HTTP 契约。
 * 协议类型只描述公开 JSON，不携带 IAR 内部会话或 Pi 运行时对象。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-20
 */

/** Pi bridge 协议版本。 */
export const PI_BRIDGE_VERSION = 'iar.pi-bridge/v1' as const;

/** Pi 输入在 IAR 边界上的唯一处置结果。 */
export type BridgeDisposition = 'pass_through' | 'handled' | 'clarification' | 'context_answered' | 'awaiting_confirmation';

/** 公开回复来源，区分 IAR 直出、回复模型和 Pi Agent。 */
export type BridgeReplySource = 'direct_function' | 'response_model' | 'pi_agent' | 'none';

/**
 * Bridge 对外传递的单轮耗时摘要。
 */
export type BridgeTimingSummary = {
  traceId: string;
  durationMs: number;
  stages: Array<{
    stage: 'semantic.extract' | 'route.propose' | 'route.select' | 'action.execute' | 'response.reasoning' | 'response.generate';
    status: 'completed' | 'failed' | 'skipped';
    durationMs: number;
    firstTokenMs?: number;
  }>;
};

/** Pi 会话标识的有界字符串类型。 */
export type PiSessionId = string;

/** IAR 会话标识的有界字符串类型。 */
export type IarSessionId = string;

/** 打开或恢复桥接会话的请求。 */
export type BridgeOpenRequest = { piSessionId: PiSessionId; iarSessionId?: IarSessionId };

/** 打开或恢复桥接会话的响应。 */
export type BridgeOpenResponse = { version: typeof PI_BRIDGE_VERSION; piSessionId: PiSessionId; iarSessionId: IarSessionId; resumed: boolean };

/** 路由公开证据，不包含模型原文、权限或敏感输入。 */
export type BridgeRouteEvidence = { status: string; reasonCode: string; semanticIntent: string; semanticConfidence: number; functionId?: string; pluginId?: string; operationKind?: 'read' | 'action'; expectedOperation?: string; actualOperation?: string };

/** pass-through 交给下游模型的有界能力描述。 */
export type BridgeCapabilityDescriptor = { functionId: string; pluginId: string; description: string; actionTypes: string[] };

/** pass-through 的模型上下文，只描述能力，不授予执行权限。 */
export type BridgeCapabilityContext = { functionDescriptors: BridgeCapabilityDescriptor[] };

/** 待确认动作的公开摘要。 */
export type BridgePendingAction = { actionId: string; runId: string; functionId: string; pluginId: string; riskLevel: string; confirmationRequired: boolean };

/** 结构化上下文中的安全主语摘要。 */
export type BridgeStructuredSubject = { type: string; id: string; status: 'resolved' | 'unresolved'; source: 'input' | 'context' | 'event' | 'plugin'; sourceEventId?: string };

/** 结构化上下文中的安全动作摘要。 */
export type BridgeStructuredAction = { name: string; status: 'proposed' | 'resolved' | 'executed' | 'failed' };

/** 结构化上下文中的安全工作流摘要。 */
export type BridgeStructuredWorkflow = { workflowId?: string; currentStep: string; status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' };

/** 结构化上下文中的字段状态，不携带字段值。 */
export type BridgeStructuredSlot = { status: 'unresolved' | 'resolved' | 'confirmed'; sourceEventId?: string };

/** 结构化上下文中的有界参数收集摘要，不携带收集值。 */
export type BridgeStructuredCollection =
  | { kind: 'function'; pluginId?: string; candidateFunctionCount: number; candidateKeys?: string[] }
  | { kind: 'parameters'; functionId: string; pluginId?: string; schemaVersion: string; collectedFields: string[]; missingFields: string[]; invalidFields: string[]; conflictFields: string[]; presentationFields: string[] };

/** 一条已验证事实的安全投影；values 仅允许公开原子事实。 */
export type BridgeStructuredFactRecord = { recordId: string; sequence: number; sourceEventId: string; functionId: string; pluginId: string; values: Record<string, string | number | boolean | null>; createdAt: string };

/** 一轮已完成会话的安全元数据，不携带用户或助手原文。 */
export type BridgeStructuredTurn = { turnId: string; sequence: number; outcome: 'completed' | 'awaiting_confirmation' | 'needs_clarification' | 'failed' | 'cancelled'; actionTaken: boolean; completedAt: string };

/** 当前 IAR 会话的安全结构化上下文投影。 */
export type BridgeStructuredContext = {
  schemaVersion: 'iar.pi-structured-context/v1';
  subject: BridgeStructuredSubject;
  intent: string;
  action: BridgeStructuredAction;
  route: { functionId?: string; pluginId?: string };
  routingScope?: { activePluginId?: string; candidatePluginIds: string[]; actionTypes: string[]; continuation: 'none' | 'reuse' | 'replace' };
  slots: Record<string, BridgeStructuredSlot>;
  workflow: BridgeStructuredWorkflow;
  pending: { kind: 'slot' | 'selection' | 'confirmation' | 'input'; status: 'required' | 'received' | 'none' };
  clarification?: { mode: 'none' | 'unresolved' | 'selection'; unresolvedStreak: number; reasonCode?: string; candidateVersion?: string; candidateKeys?: string[] };
  collection?: BridgeStructuredCollection;
  pendingReference?: { relation: 'current' | 'previous' | 'next' | 'first' | 'last' | 'offset'; anchorRecordId?: string; offset?: number; candidateRecordIds: string[] };
  confirmation: { state: 'not_required' | 'required' | 'confirmed' | 'rejected' };
  factHistory: { records: BridgeStructuredFactRecord[]; focusRecordId?: string };
  conversationTurns: { turns: BridgeStructuredTurn[]; focusTurnId?: string };
  summary?: { version: string; eventId: string };
  integrity: { criticalFieldHash: string; lastEventId: string };
};

/** 当前 IAR Workflow 的安全状态投影。 */
export type BridgeWorkflowState = {
  mapVersion: 'iar.workflow-map/v1';
  currentState: string;
  activeState: string;
  outcome: 'none' | 'completed' | 'cancelled' | 'failed';
  workflowStatus: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  allowedEvents: string[];
  pending: { kind: 'slot' | 'selection' | 'confirmation' | 'input'; status: 'required' | 'received' | 'none' };
  confirmation: { state: 'not_required' | 'required' | 'confirmed' | 'rejected' };
  route?: { functionId?: string; pluginId?: string };
  collection?: BridgeStructuredCollection;
};

/** 输入请求。 */
export type BridgeInputRequest = { text: string; requestId?: string };

/** 输入响应。 */
export type BridgeInputResponse = { version: typeof PI_BRIDGE_VERSION; iarSessionId: IarSessionId; disposition: BridgeDisposition; reply?: string; reasonCode?: string; route?: BridgeRouteEvidence; pending?: BridgePendingAction; capabilityContext?: BridgeCapabilityContext; replySource?: BridgeReplySource; timing?: BridgeTimingSummary };

/** Bridge 输入流只允许最终回复阶段的 reasoning/answer 增量。 */
export type BridgeInputStreamEvent =
  | { type: 'reasoningDelta'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'timing'; summary: BridgeTimingSummary }
  | { type: 'done'; result: BridgeInputResponse }
  | { type: 'error'; code: string; message: string; retryable: boolean };

/** 确认或取消请求。 */
export type BridgeConfirmRequest = { actionId: string; accepted: boolean; requestId?: string };

/** 确认或取消响应。 */
export type BridgeConfirmResponse = { version: typeof PI_BRIDGE_VERSION; iarSessionId: IarSessionId; disposition: 'handled'; reply: string; reasonCode?: string; pending?: BridgePendingAction; replySource?: BridgeReplySource; timing?: BridgeTimingSummary };

/** 状态响应返回待确认摘要及当前会话的安全上下文投影。 */
export type BridgeStateResponse = { version: typeof PI_BRIDGE_VERSION; iarSessionId: IarSessionId; pending?: BridgePendingAction; structuredContext?: BridgeStructuredContext; workflowState?: BridgeWorkflowState };

/** Bridge HTTP 失败的稳定公开结构。 */
export type BridgeErrorResponse = { version: typeof PI_BRIDGE_VERSION; code: string; message: string; retryable: boolean };

/** 判断未知值是否为合法桥接 disposition。 */
export function isBridgeDisposition(value: unknown): value is BridgeDisposition {
  return value === 'pass_through' || value === 'handled' || value === 'clarification' || value === 'context_answered' || value === 'awaiting_confirmation';
}

/** 判断未知值是否为合法回复来源。 */
export function isBridgeReplySource(value: unknown): value is BridgeReplySource {
  return value === 'direct_function' || value === 'response_model' || value === 'pi_agent' || value === 'none';
}
