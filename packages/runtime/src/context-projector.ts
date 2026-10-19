/**
 * 实现可重放的 BehaviorContext 投影和关键字段哈希校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createHash } from 'node:crypto';
import { ERROR_CODES, MAX_TRUSTED_FACTS, MAX_TRUSTED_FACT_STRING_LENGTH, TRUSTED_FACT_FIELDS, validateContract, type BehaviorContext, type ContractErrorResult, type EventEnvelope, type TrustedFact, type TrustedFactValue } from '@iar/contracts';

/** 关键字段哈希固定使用 SHA-256，避免实现更换导致快照不可恢复。 */
const HASH_ALGORITHM = 'sha256';

/** BehaviorContext 工作流状态的运行时允许集合。 */
const WORKFLOW_STATUSES = new Set(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']);

/** Action 状态的运行时允许集合。 */
const ACTION_STATUSES = new Set(['proposed', 'resolved', 'executed', 'failed']);

/** Pending 输入类型的运行时允许集合。 */
const PENDING_KINDS = new Set(['slot', 'selection', 'confirmation', 'input']);

/** Pending 状态的运行时允许集合。 */
const PENDING_STATUSES = new Set(['required', 'received', 'none']);

/** Confirmation 状态的运行时允许集合。 */
const CONFIRMATION_STATES = new Set(['not_required', 'required', 'confirmed', 'rejected']);

/** 投影失败时返回的结构化错误。 */
export type ProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractErrorResult };

/** 递归按 key 排序，确保相同 JSON 状态生成相同字节序列。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]);
  return Object.fromEntries(entries);
}

/**
 * 对影响执行的关键行为字段计算 SHA-256。
 *
 * @param context - 待计算的行为上下文
 * @returns 关键字段的稳定十六进制哈希
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function criticalFieldHash(context: BehaviorContext): string {
  const critical = {
    subject: context.subject,
    intent: context.intent,
    action: context.action,
    route: context.route,
    slots: context.slots,
    workflow: context.workflow,
    pending: context.pending,
    confirmation: context.confirmation,
    idempotencyKey: context.idempotencyKey,
    ...(context.facts ? { facts: context.facts } : {})
  };
  return createHash(HASH_ALGORITHM).update(JSON.stringify(canonicalize(critical))).digest('hex');
}

/**
 * 创建可作为事件投影起点的最小行为上下文。
 *
 * @param runId - 运行实例标识
 * @returns 带有初始完整性哈希的行为上下文
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function createInitialContext(runId = 'unknown-run'): BehaviorContext {
  const initial: BehaviorContext = {
    schemaVersion: 'iar.behavior-context/v1',
    subject: { type: 'unknown', id: 'unknown', status: 'unresolved', source: 'event' },
    intent: 'unknown',
    action: { name: 'unknown', status: 'proposed' },
    route: {},
    slots: {},
    workflow: { currentStep: 'initial', status: 'pending' },
    pending: { kind: 'input', status: 'none' },
    confirmation: { state: 'not_required' },
    facts: {},
    idempotencyKey: `run:${runId}`,
    integrity: { criticalFieldHash: '', lastEventId: 'initial' }
  };
  initial.integrity.criticalFieldHash = criticalFieldHash(initial);
  return initial;
}

/** 维护一个可复制的 BehaviorContext 当前投影。 */
export class BehaviorContextProjector {
  /** 当前投影只通过事件或完整校验替换。 */
  private state: BehaviorContext;

  /**
   * 从已有上下文创建投影器。
   *
   * @param initial - 已可信的初始行为上下文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(initial: BehaviorContext = createInitialContext()) {
    this.state = structuredClone(initial);
    if (!validateContract('behaviorContext', this.state).ok) {
      throw new Error('BehaviorContext 初始契约无效');
    }
    if (criticalFieldHash(this.state) !== this.state.integrity.criticalFieldHash) {
      throw new Error('BehaviorContext 初始关键字段哈希不匹配');
    }
  }

  /**
   * 返回当前状态的深拷贝。
   *
   * @returns 当前行为上下文快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public current(): BehaviorContext {
    return structuredClone(this.state);
  }

  /**
   * 将单个事实事件投影到当前状态。
   *
   * @param event - 待投影的不可变事实事件
   * @returns 投影后的行为上下文快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public apply(event: EventEnvelope): BehaviorContext {
    const previous = this.state;
    this.state = structuredClone(previous);
    try {
      this.applyPayload(event);
      this.assertValidState();
      this.state.integrity = { criticalFieldHash: criticalFieldHash(this.state), lastEventId: event.eventId };
      return this.current();
    } catch (error) {
      this.state = previous;
      throw error;
    }
  }

  /**
   * 只有关键字段哈希匹配当前可信状态时才接受候选压缩视图。
   *
   * @param candidate - 压缩器返回的候选行为上下文
   * @returns 接受后的快照或完整性错误
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public replaceIfIntegrityMatches(candidate: BehaviorContext): ProjectionResult<BehaviorContext> {
    if (!validateContract('behaviorContext', candidate).ok) return { ok: false, error: projectionError('BehaviorContext 候选契约无效') };
    const trustedHash = this.state.integrity.criticalFieldHash;
    if (criticalFieldHash(candidate) !== trustedHash) {
      return { ok: false, error: projectionError('BehaviorContext 关键字段哈希不匹配') };
    }
    this.state = structuredClone(candidate);
    this.state.integrity.criticalFieldHash = criticalFieldHash(this.state);
    return { ok: true, value: this.current() };
  }

  /** 按事件类型更新可重放字段。 */
  private applyPayload(event: EventEnvelope): void {
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
    // workflow.started 固定主语、意图和运行状态。
    if (event.eventName === 'workflow.started') this.applyWorkflowStarted(payload, event.eventId);
    // decision.created 固定当前 Function 和 Plugin 路由。
    if (event.eventName === 'decision.created') this.applyDecision(payload);
    // workflow.transitioned 固定恢复步骤和幂等键。
    if (event.eventName === 'workflow.transitioned') this.applyWorkflowTransition(payload);
    // 共享状态字段在所有相关事件中保持可重放。
    this.applySharedState(payload, event.eventId);
    // Action 事件只更新可重放的执行阶段，不重复执行副作用。
    if (event.eventName === 'action.started') this.state.action.status = 'resolved';
    if (event.eventName === 'action.completed') this.state.action.status = 'executed';
    if (event.eventName === 'action.failed') this.state.action.status = 'failed';
    if (event.eventName === 'action.completed') this.applyTrustedFacts(payload, event.eventId);
  }

  /** 投影开始事件中的主语和意图。 */
  private applyWorkflowStarted(payload: Record<string, unknown>, eventId: string): void {
    if (typeof payload.subjectId === 'string') {
      this.state.subject = {
        type: typeof payload.subjectType === 'string' ? payload.subjectType : 'unknown',
        id: payload.subjectId,
        status: 'resolved',
        source: 'event',
        sourceEventId: eventId
      };
    }
    if (typeof payload.intent === 'string') this.state.intent = payload.intent;
    this.state.workflow.status = 'running';
  }

  /** 投影事件中的完整行为关键字段。 */
  private applySharedState(payload: Record<string, unknown>, eventId: string): void {
    if (isSubjectReference(payload.subject)) {
      this.state.subject = { ...payload.subject, sourceEventId: payload.subject.sourceEventId ?? eventId };
    }
    if (typeof payload.workflowId === 'string') this.state.workflow.workflowId = payload.workflowId;
    if (typeof payload.actionName === 'string') this.state.action.name = payload.actionName;
    if (isActionStatus(payload.actionStatus)) this.state.action.status = payload.actionStatus;
    if (isSlotMap(payload.slots)) this.state.slots = structuredClone(payload.slots);
    if (isPendingInput(payload.pending)) this.state.pending = { ...payload.pending };
    if (isConfirmationState(payload.confirmation)) this.state.confirmation = { ...payload.confirmation };
  }

  /** 投影决策事件中的 Function 和 Plugin 路由。 */
  private applyDecision(payload: Record<string, unknown>): void {
    if (typeof payload.functionId === 'string') this.state.route.functionId = payload.functionId;
    if (typeof payload.pluginId === 'string') this.state.route.pluginId = payload.pluginId;
  }

  /** 投影工作流位置和幂等键。 */
  private applyWorkflowTransition(payload: Record<string, unknown>): void {
    if (typeof payload.currentStep === 'string') this.state.workflow.currentStep = payload.currentStep;
    if (typeof payload.status === 'string' && WORKFLOW_STATUSES.has(payload.status)) {
      this.state.workflow.status = payload.status as BehaviorContext['workflow']['status'];
    }
    if (typeof payload.idempotencyKey === 'string') this.state.idempotencyKey = payload.idempotencyKey;
  }

  /** 从成功 Action 的公开输出中投影有界、可追溯事实。 */
  private applyTrustedFacts(payload: Record<string, unknown>, eventId: string): void {
    if (payload.resultStatus !== 'succeeded' || !isRecord(payload.output)) return;
    const functionId = stringValue(payload.functionId);
    const pluginId = stringValue(payload.pluginId);
    const publicFacts = payload.output.facts;
    if (!isRecord(publicFacts) || Object.keys(publicFacts).length > MAX_TRUSTED_FACTS) return;
    if (!functionId || !pluginId) return;
    const next = { ...(this.state.facts ?? {}) };
    for (const [field, value] of Object.entries(publicFacts)) {
      if (!isTrustedFactField(field) || !isBoundedFactValue(value)) continue;
      const fact: TrustedFact = { value, status: 'verified', sourceEventId: eventId, functionId, pluginId, field };
      next[`${functionId}.${field}`] = fact;
    }
    this.state.facts = next;
  }

  /** 确保每个事实事件都不能把投影推进到非法状态。 */
  private assertValidState(): void {
    if (!validateContract('behaviorContext', this.state).ok) throw new Error('事件投影产生非法 BehaviorContext');
  }
}

/** 构造投影完整性失败的稳定错误。 */
function projectionError(message: string): ContractErrorResult {
  return { schemaVersion: 'iar.error/v1', code: ERROR_CODES.CONTRACT_VALIDATION_FAILED, message, retryable: false };
}

/** 判断事件中的对象是否为普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取非空字符串元数据。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 判断字段是否在通用事实白名单中。 */
function isTrustedFactField(value: string): boolean {
  return (TRUSTED_FACT_FIELDS as readonly string[]).includes(value);
}

/** 事实值只允许小型 JSON 原子值，避免把日志或任意对象带入上下文。 */
function isBoundedFactValue(value: unknown): value is TrustedFactValue {
  return (typeof value === 'string' && Array.from(value).length <= MAX_TRUSTED_FACT_STRING_LENGTH) || typeof value === 'number' || typeof value === 'boolean' || value === null;
}

/** 判断主语引用字段是否完整。 */
function isSubjectReference(value: unknown): value is BehaviorContext['subject'] {
  if (!isRecord(value)) return false;
  return typeof value.type === 'string'
    && typeof value.id === 'string'
    && (value.status === 'resolved' || value.status === 'unresolved')
    && ['input', 'context', 'event', 'plugin'].includes(String(value.source));
}

/** 判断槽位表中的每个槽位是否满足最小投影结构。 */
function isSlotMap(value: unknown): value is BehaviorContext['slots'] {
  if (!isRecord(value)) return false;
  return Object.values(value).every((slot) => isRecord(slot)
    && (slot.status === 'unresolved' || slot.status === 'resolved' || slot.status === 'confirmed')
    && Object.hasOwn(slot, 'value'));
}

/** 判断等待输入状态是否完整。 */
function isPendingInput(value: unknown): value is BehaviorContext['pending'] {
  return isRecord(value)
    && PENDING_KINDS.has(String(value.kind))
    && PENDING_STATUSES.has(String(value.status));
}

/** 判断确认状态是否完整。 */
function isConfirmationState(value: unknown): value is BehaviorContext['confirmation'] {
  return isRecord(value)
    && CONFIRMATION_STATES.has(String(value.state));
}

/** 判断 Action 阶段是否为契约允许的值。 */
function isActionStatus(value: unknown): value is BehaviorContext['action']['status'] {
  return ACTION_STATUSES.has(String(value));
}
