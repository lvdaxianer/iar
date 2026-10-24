/**
 * 将权威 BehaviorContext 投影为 Pi Bridge 可复制的安全状态。
 * 这里只保留结构、状态、已验证事实和轮次元数据，不改变业务状态机。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
import type { BehaviorContext } from '@iar/contracts';
import { projectWorkflowContext } from '@iar/runtime';
import type { BridgeStateResponse, BridgeStructuredContext, BridgeStructuredSlot, BridgeWorkflowState } from '@iar/pi-bridge';

/** Pi Bridge state 的两个安全投影。 */
export type BridgeContextProjection = Pick<BridgeStateResponse, 'structuredContext' | 'workflowState'> & { structuredContext: BridgeStructuredContext; workflowState: BridgeWorkflowState };

/**
 * 从当前权威 BehaviorContext 生成结构化上下文和 Workflow state。
 *
 * @param context - 已校验的当前会话上下文
 * @returns 可安全传输和复制的 Bridge 状态投影
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
export function projectBridgeContext(context: BehaviorContext): BridgeContextProjection {
  const workflowState = projectWorkflowState(context);
  return { structuredContext: projectStructuredContext(context, workflowState), workflowState };
}

/**
 * 生成不含原始文本和值的结构化上下文。
 *
 * @param context - 已校验的当前会话上下文
 * @param workflowState - 与同一上下文生成的 Workflow 投影
 * @returns 安全结构化上下文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectStructuredContext(context: BehaviorContext, workflowState: BridgeWorkflowState): BridgeStructuredContext {
  return {
    schemaVersion: 'iar.pi-structured-context/v1',
    subject: { ...context.subject },
    intent: context.intent,
    action: { ...context.action },
    route: { ...context.route },
    ...(context.routingScope ? { routingScope: { ...context.routingScope, candidatePluginIds: [...context.routingScope.candidatePluginIds], actionTypes: [...context.routingScope.actionTypes] } } : {}),
    slots: projectSlots(context),
    workflow: { ...context.workflow },
    pending: { kind: context.pending.kind, status: context.pending.status },
    ...(context.clarification ? { clarification: { ...context.clarification, ...(context.clarification.candidateKeys ? { candidateKeys: [...context.clarification.candidateKeys] } : {}) } } : {}),
    ...(workflowState.collection ? { collection: structuredClone(workflowState.collection) } : {}),
    ...(context.pendingReference ? { pendingReference: projectPendingReference(context.pendingReference) } : {}),
    confirmation: { state: context.confirmation.state },
    factHistory: projectFactHistory(context),
    conversationTurns: projectConversationTurns(context),
    ...(context.summary ? { summary: { version: context.summary.version, eventId: context.summary.eventId } } : {}),
    integrity: { ...context.integrity }
  };
}

/**
 * 生成与 Workflow projection 一致的状态摘要。
 *
 * @param context - 已校验的当前会话上下文
 * @returns 不含执行授权的 Workflow 状态
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectWorkflowState(context: BehaviorContext): BridgeWorkflowState {
  const projected = projectWorkflowContext(context);
  return { ...projected, allowedEvents: [...projected.allowedEvents], ...(projected.route ? { route: { ...projected.route } } : {}), ...(projected.collection ? { collection: structuredClone(projected.collection) } : {}) };
}

/**
 * 只投影槽位状态，不复制槽位值。
 *
 * @param context - 当前会话上下文
 * @returns 槽位状态映射
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectSlots(context: BehaviorContext): Record<string, BridgeStructuredSlot> {
  return Object.fromEntries(Object.entries(context.slots).map(([key, slot]) => [key, { status: slot.status, ...(slot.sourceEventId ? { sourceEventId: slot.sourceEventId } : {}) }]));
}

/**
 * 只保留待解析引用关系和不透明记录标识。
 *
 * @param reference - 当前待解析引用
 * @returns 不含引用原文的安全摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectPendingReference(reference: NonNullable<BehaviorContext['pendingReference']>): NonNullable<BridgeStructuredContext['pendingReference']> {
  return { relation: reference.relation, ...(reference.anchorRecordId ? { anchorRecordId: reference.anchorRecordId } : {}), ...(reference.offset === undefined ? {} : { offset: reference.offset }), candidateRecordIds: [...reference.candidateRecordIds] };
}

/**
 * 复制已验证事实链，事实值属于运行时明确声明的公开原子字段。
 *
 * @param context - 当前会话上下文
 * @returns 有界已验证事实摘要
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectFactHistory(context: BehaviorContext): BridgeStructuredContext['factHistory'] {
  const history = context.factHistory ?? { records: [] };
  return { records: history.records.map((record) => ({ ...record, values: { ...record.values } })), ...(history.focusRecordId ? { focusRecordId: history.focusRecordId } : {}) };
}

/**
 * 复制轮次顺序和结果元数据，过滤用户与助手原文。
 *
 * @param context - 当前会话上下文
 * @returns 有界会话轮次元数据
 * @author lvdaxianer@yeah.net
 * @date 2026-10-24
 */
function projectConversationTurns(context: BehaviorContext): BridgeStructuredContext['conversationTurns'] {
  const history = context.conversationTurns ?? { turns: [] };
  return {
    turns: history.turns.map((turn) => ({ turnId: turn.turnId, sequence: turn.sequence, outcome: turn.outcome, actionTaken: turn.actionTaken, completedAt: turn.completedAt })),
    ...(history.focusTurnId ? { focusTurnId: history.focusTurnId } : {})
  };
}
