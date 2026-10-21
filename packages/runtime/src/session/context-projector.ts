/**
 * 实现可重放的 BehaviorContext 投影和关键字段哈希校验。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { createHash } from 'node:crypto';
import { ERROR_CODES, MAX_CANDIDATE_KEY_LENGTH, MAX_CANDIDATE_VERSION_LENGTH, MAX_CLARIFICATION_REASON_LENGTH, MAX_CLARIFICATION_OPTIONS, MAX_FACT_RECORD_ID_LENGTH, MAX_FACT_RECORD_VALUES, MAX_PENDING_REFERENCE_CANDIDATES, MAX_PENDING_REFERENCE_OFFSET, MAX_PENDING_REFERENCE_TEXT_LENGTH, MAX_UNRESOLVED_STREAK, MAX_TRUSTED_FACTS, MAX_TRUSTED_FACT_KEY_LENGTH, MAX_TRUSTED_FACT_STRING_LENGTH, TRUSTED_FACT_KEY_PATTERN, validateContract, type BehaviorContext, type ClarificationState, type ContractErrorResult, type EventEnvelope, type PendingReference, type RoutingScope, type VerifiedFactHistory, type TrustedFactValue, type VerifiedFactRecord } from '@iar/contracts';

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
    ...(context.routingScope ? { routingScope: context.routingScope } : {}),
    slots: context.slots,
    workflow: context.workflow,
    pending: context.pending,
    ...(context.clarification ? { clarification: context.clarification } : {}),
    ...(context.pendingReference ? { pendingReference: context.pendingReference } : {}),
    confirmation: context.confirmation,
    idempotencyKey: context.idempotencyKey,
    ...(context.factHistory ? { factHistory: context.factHistory } : {}),
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
    routingScope: { candidatePluginIds: [], actionTypes: [], continuation: 'none' },
    slots: {},
    workflow: { currentStep: 'initial', status: 'pending' },
    pending: { kind: 'input', status: 'none' },
    clarification: { mode: 'none', unresolvedStreak: 0 },
    confirmation: { state: 'not_required' },
    factHistory: { records: [] },
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
    const snapshot = structuredClone(initial);
    if (!validateContract('behaviorContext', snapshot).ok) {
      throw new Error('BehaviorContext 初始契约无效');
    }
    if (criticalFieldHash(snapshot) !== snapshot.integrity.criticalFieldHash) {
      throw new Error('BehaviorContext 初始关键字段哈希不匹配');
    }
    this.state = normalizeBehaviorContext(snapshot);
    this.state.integrity.criticalFieldHash = criticalFieldHash(this.state);
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
    if (event.eventName === 'context.compacted') {
      this.applyCompactedState(payload);
      return;
    }
    if (event.eventName === 'context.clarification.updated' && (!isPendingInput(payload.pending) || (payload.clarification !== undefined && !isClarificationState(payload.clarification)) || (payload.pendingReference !== undefined && payload.pendingReference !== null && !isPendingReference(payload.pendingReference)))) {
      throw new Error('澄清 pending 状态无效');
    }
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
    if (event.eventName === 'action.completed') this.applyTrustedFacts(payload, event.eventId, event.occurredAt);
  }

  /** 从已校验的压缩事件恢复完整状态和摘要，拒绝伪造的快照。 */
  private applyCompactedState(payload: Record<string, unknown>): void {
    const state = payload.state;
    const hash = payload.criticalFieldHash;
    if (!isRecord(state) || typeof hash !== 'string' || !validateContract('behaviorContext', state).ok) throw new Error('压缩事件状态无效');
    const context = structuredClone(state) as BehaviorContext;
    if (criticalFieldHash(context) !== hash) throw new Error('压缩事件关键字段哈希不匹配');
    this.state = context;
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
    if (isClarificationState(payload.clarification)) this.state.clarification = structuredClone(payload.clarification);
    if (isPendingReference(payload.pendingReference)) this.state.pendingReference = structuredClone(payload.pendingReference);
    if (payload.pendingReference === null) delete this.state.pendingReference;
    if (isConfirmationState(payload.confirmation)) this.state.confirmation = { ...payload.confirmation };
    if (isRoutingScope(payload.routingScope)) this.state.routingScope = structuredClone(payload.routingScope);
  }

  /** 投影决策事件中的 Function 和 Plugin 路由。 */
  private applyDecision(payload: Record<string, unknown>): void {
    if (typeof payload.functionId === 'string') this.state.route.functionId = payload.functionId;
    if (typeof payload.pluginId === 'string') this.state.route.pluginId = payload.pluginId;
    if (isRoutingScope(payload.routingScope)) this.state.routingScope = structuredClone(payload.routingScope);
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
  private applyTrustedFacts(payload: Record<string, unknown>, eventId: string, occurredAt: string): void {
    const input = readFactRecordInput(payload);
    if (!input) return;
    const history = this.state.factHistory ?? { records: [] };
    if (history.records.some((record) => record.sourceEventId === eventId)) return;
    const values = collectTrustedFactValues(input.publicFacts);
    if (values === undefined) return;
    const record = createFactRecord(input.functionId, input.pluginId, eventId, occurredAt, history.records, values);
    this.state.factHistory = appendFactRecord(history, record);
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

/** 判断事件中的路由范围是否满足运行时的有界结构。 */
function isRoutingScope(value: unknown): value is RoutingScope {
  if (!isRecord(value)) return false;
  if (value.activePluginId !== undefined && typeof value.activePluginId !== 'string') return false;
  if (!Array.isArray(value.candidatePluginIds) || !value.candidatePluginIds.every((item) => typeof item === 'string')) return false;
  if (!Array.isArray(value.actionTypes) || !value.actionTypes.every((item) => ['query', 'create', 'update', 'delete', 'transfer', 'execute'].includes(item as string))) return false;
  return value.continuation === 'none' || value.continuation === 'reuse' || value.continuation === 'replace';
}

/** 读取非空字符串元数据。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 判断字段是否满足通用事实键边界。 */
function isTrustedFactField(value: string): boolean {
  return value.length <= MAX_TRUSTED_FACT_KEY_LENGTH && new RegExp(TRUSTED_FACT_KEY_PATTERN).test(value);
}

/** 事实值只允许小型 JSON 原子值，避免把日志或任意对象带入上下文。 */
function isBoundedFactValue(value: unknown): value is TrustedFactValue {
  return (typeof value === 'string' && Array.from(value).length <= MAX_TRUSTED_FACT_STRING_LENGTH) || typeof value === 'number' || typeof value === 'boolean' || value === null;
}

/** 读取成功动作中用于创建事实记录的动态来源信息。 */
function readFactRecordInput(payload: Record<string, unknown>): { functionId: string; pluginId: string; publicFacts: Record<string, unknown> } | undefined {
  if (payload.resultStatus !== 'succeeded' || !isRecord(payload.output)) return undefined;
  const functionId = stringValue(payload.functionId);
  const pluginId = stringValue(payload.pluginId);
  const publicFacts = payload.output.facts;
  if (!functionId || !pluginId || !isRecord(publicFacts)) return undefined;
  return { functionId, pluginId, publicFacts };
}

/** 过滤 Plugin 事实信封中的字段和值，阻止任意对象进入可信上下文。 */
function collectTrustedFactValues(publicFacts: Record<string, unknown>): Record<string, TrustedFactValue> | undefined {
  const entries = Object.entries(publicFacts);
  if (entries.length === 0 || entries.length > MAX_FACT_RECORD_VALUES) return undefined;
  const values: Record<string, TrustedFactValue> = {};
  for (const [field, value] of entries) {
    if (isTrustedFactField(field) && isBoundedFactValue(value)) values[field] = value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/** 创建可在事件重放中稳定复现的不透明事实记录。 */
function createFactRecord(functionId: string, pluginId: string, eventId: string, occurredAt: string, records: VerifiedFactRecord[], values: Record<string, TrustedFactValue>): VerifiedFactRecord {
  const sequence = (records.at(-1)?.sequence ?? 0) + 1;
  const recordId = `fact-${createHash(HASH_ALGORITHM).update(eventId).digest('hex')}`.slice(0, MAX_FACT_RECORD_ID_LENGTH);
  return { recordId, sequence, sourceEventId: eventId, functionId, pluginId, values, createdAt: occurredAt };
}

/** 追加事实并在超过窗口时裁剪最早记录，始终把最新结果设为焦点。 */
function appendFactRecord(history: VerifiedFactHistory, record: VerifiedFactRecord): VerifiedFactHistory {
  const records = [...history.records, record].slice(-MAX_TRUSTED_FACTS);
  return { records, focusRecordId: record.recordId };
}

/** 将旧版 facts map 转换为新的事实记录集合。 */
function normalizeBehaviorContext(context: BehaviorContext): BehaviorContext {
  if (context.factHistory !== undefined || context.facts === undefined) return context;
  const records = Object.values(context.facts).map((fact, index) => legacyFactRecord(fact, index));
  const { facts: _legacyFacts, ...withoutLegacyFacts } = context;
  const focusRecordId = records.at(-1)?.recordId;
  return focusRecordId === undefined
    ? { ...withoutLegacyFacts, factHistory: { records } }
    : { ...withoutLegacyFacts, factHistory: { records, focusRecordId } };
}

/** 把旧版单字段事实转换为可追溯记录。 */
function legacyFactRecord(fact: { value: TrustedFactValue; sourceEventId: string; functionId: string; pluginId: string; field: string }, index: number): VerifiedFactRecord {
  const recordId = `legacy-${createHash(HASH_ALGORITHM).update(`${fact.sourceEventId}:${fact.field}`).digest('hex')}`.slice(0, MAX_FACT_RECORD_ID_LENGTH);
  return { recordId, sequence: index + 1, sourceEventId: fact.sourceEventId, functionId: fact.functionId, pluginId: fact.pluginId, values: { [fact.field]: fact.value }, createdAt: 'legacy' };
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
  if (!isRecord(value) || !PENDING_KINDS.has(String(value.kind)) || !PENDING_STATUSES.has(String(value.status))) return false;
  if (value.options === undefined) return true;
  if (!Array.isArray(value.options) || value.options.length > 12) return false;
  const keys = new Set<string>();
  return value.options.every((option) => {
    if (!isRecord(option) || typeof option.key !== 'string' || option.key.length === 0 || option.key.length > 60 || typeof option.label !== 'string' || option.label.length === 0 || option.label.length > 200 || keys.has(option.key)) return false;
    keys.add(option.key);
    return true;
  });
}

/** 判断待解析事实引用是否为有限且不透明的状态。 */
function isPendingReference(value: unknown): value is PendingReference {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_PENDING_REFERENCE_TEXT_LENGTH) return false;
  if (!['current', 'previous', 'next', 'first', 'last', 'offset'].includes(String(value.relation))) return false;
  if (value.anchorRecordId !== undefined && (typeof value.anchorRecordId !== 'string' || value.anchorRecordId.length === 0 || value.anchorRecordId.length > MAX_FACT_RECORD_ID_LENGTH)) return false;
  if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || Math.abs(Number(value.offset)) > MAX_PENDING_REFERENCE_OFFSET)) return false;
  if (!Array.isArray(value.candidateRecordIds) || value.candidateRecordIds.length === 0 || value.candidateRecordIds.length > MAX_PENDING_REFERENCE_CANDIDATES) return false;
  const recordIds = new Set<string>();
  return value.candidateRecordIds.every((recordId) => typeof recordId === 'string' && recordId.length > 0 && recordId.length <= MAX_FACT_RECORD_ID_LENGTH && !recordIds.has(recordId) && (recordIds.add(recordId), true));
}

/** 判断事件中的连续澄清状态是否满足通用契约边界。 */
function isClarificationState(value: unknown): value is ClarificationState {
  if (!isRecord(value) || !['none', 'unresolved', 'selection'].includes(String(value.mode)) || !Number.isSafeInteger(value.unresolvedStreak) || Number(value.unresolvedStreak) < 0 || Number(value.unresolvedStreak) > MAX_UNRESOLVED_STREAK) return false;
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || value.reasonCode.length === 0 || value.reasonCode.length > MAX_CLARIFICATION_REASON_LENGTH)) return false;
  if (value.candidateVersion !== undefined && (typeof value.candidateVersion !== 'string' || value.candidateVersion.length === 0 || value.candidateVersion.length > MAX_CANDIDATE_VERSION_LENGTH)) return false;
  if (value.candidateKeys === undefined) return true;
  if (!Array.isArray(value.candidateKeys) || value.candidateKeys.length > MAX_CLARIFICATION_OPTIONS) return false;
  const keys = new Set<string>();
  return value.candidateKeys.every((key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_CANDIDATE_KEY_LENGTH && !keys.has(key) && (keys.add(key), true));
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
