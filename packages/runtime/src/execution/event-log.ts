/**
 * 提供本地 Workflow 和 Action 的版本化可重放事件 sink。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { SCHEMA_VERSIONS, validateContract, type ActionDefinition, type ActionResult, type ClarificationState, type CollectionState, type EventEnvelope, type JsonValue, type PendingInput, type PendingReference } from '@iar/contracts';
import type { WorkflowRun } from './types.js';

/** WorkflowEventLog 的时钟和链路配置。 */
export type WorkflowEventLogOptions = {
  /** 生成事件发生时间的函数。 */
  clock?: () => string;
  /** 绑定同一运行链路的 correlationId。 */
  correlationId?: string;
  /** 事件编号前缀；服务重启或会话隔离时必须使用唯一前缀。 */
  eventIdPrefix?: string;
};

/**
 * 记录本地 Workflow、Action 结果和拒绝路径的 EventEnvelope。
 *
 * 该类只负责进程内事件事实，不执行 Action，也不替代 durable EventStore。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class WorkflowEventLog {
  private readonly records: EventEnvelope[] = [];
  private readonly clock: () => string;
  private readonly correlationId: string;
  private readonly eventIdPrefix: string;
  private nextId = 1;

  /**
   * 创建带有可注入时钟的本地事件 sink。
   * @param options - 时钟和 correlation 配置
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: WorkflowEventLogOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.correlationId = options.correlationId ?? 'workflow-local';
    this.eventIdPrefix = options.eventIdPrefix ?? 'workflow-event';
  }

  /**
   * 返回事件深拷贝，调用方不能修改事实源。
   * @returns 按追加顺序排列的事件快照
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get events(): readonly EventEnvelope[] {
    return this.records.map((event) => structuredClone(event));
  }

  /**
   * 记录 Workflow 开始事实。
   * @param run - 当前 Workflow 快照
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public workflowStarted(run: WorkflowRun): void {
    this.append('workflow.started', run.runId, { workflowId: run.workflowId, currentStep: run.currentStep, status: run.status });
  }

  /**
   * 记录 Workflow 状态和 confirmation 快照。
   * @param run - 当前 Workflow 快照
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public workflowTransitioned(run: WorkflowRun): void {
    const payload: Record<string, JsonValue> = { workflowId: run.workflowId, currentStep: run.currentStep, status: run.status, confirmation: run.confirmation };
    if (run.action) payload.actionId = run.action.actionId;
    if (run.actionStatus) payload.actionStatus = run.actionStatus === 'succeeded' ? 'executed' : run.actionStatus === 'failed' ? 'failed' : 'resolved';
    if (run.action?.idempotencyKey) payload.idempotencyKey = run.action.idempotencyKey;
    this.append('workflow.transitioned', run.runId, payload);
  }

  /**
   * 记录 Action 已通过幂等门禁并即将调用 executor。
   * @param action - 已通过 Policy 的 Action
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public actionStarted(action: ActionDefinition): void {
    assertAction(action);
    this.append('action.started', action.runId, actionPayload(action, { actionStatus: 'resolved' }));
  }

  /**
   * 记录 Action 的成功或重复结果。
   * @param action - 原始 Action
   * @param result - Schema 校验后的结果
   * @param reasonCode - 可选的结果分类
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public actionCompleted(action: ActionDefinition, result: ActionResult, reasonCode?: string): void {
    assertAction(action);
    assertActionResult(result);
    const payload = actionPayload(action, { actionStatus: 'executed', resultStatus: result.status });
    if (result.output !== undefined) payload.output = result.output;
    if (reasonCode) payload.reasonCode = reasonCode;
    this.append('action.completed', action.runId, payload);
  }

  /**
   * 记录 Action 失败、拒绝或不可重试结果。
   * @param action - 原始 Action
   * @param errorCode - 事件中的稳定错误码
   * @param reasonCode - 对宿主公开的稳定分类
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public actionFailed(action: ActionDefinition, errorCode: string, reasonCode: string): void {
    assertAction(action);
    this.append('action.failed', action.runId, actionPayload(action, { actionStatus: 'failed', errorCode, reasonCode }));
  }

  /** 记录响应模型提出或结束澄清的结构化待输入状态。 */
  public clarificationUpdated(runId: string, pending: PendingInput, clarification?: ClarificationState, pendingReference?: PendingReference | null, collection?: CollectionState | null): void {
    this.append('context.clarification.updated', runId, { pending: structuredClone(pending) as JsonValue, ...(clarification === undefined ? {} : { clarification: structuredClone(clarification) as JsonValue }), ...(pendingReference === undefined ? {} : { pendingReference: structuredClone(pendingReference) as JsonValue }), ...(collection === undefined ? {} : { collection: structuredClone(collection) as JsonValue }) });
  }

  /** 记录已解析的事实焦点，供下一轮“这个/当前”指代使用。 */
  public factFocused(runId: string, recordId: string): void {
    this.append('context.fact.focused', runId, { recordId });
  }

  /**
   * 构造并校验一个不可变事件。
   * @param eventName - 有限事件名称
   * @param runId - 运行实例标识
   * @param payload - JSON-safe 事件载荷
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private append(eventName: EventEnvelope['eventName'], runId: string, payload: Record<string, JsonValue>): void {
    const event: EventEnvelope = { schemaVersion: SCHEMA_VERSIONS.event, eventId: `${this.eventIdPrefix}-${this.nextId++}`, eventName, occurredAt: this.clock(), runId, correlationId: this.correlationId, payload };
    if (!validateContract('event', event).ok) throw new Error(`Workflow 事件无效: ${event.eventId}`);
    this.records.push(structuredClone(event));
  }
}

/**
 * 构造 Action 事件的公共 JSON 载荷。
 * @param action - Action 定义
 * @param extra - 事件阶段和结果字段
 * @returns JSON-safe Action 载荷
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function actionPayload(action: ActionDefinition, extra: Record<string, JsonValue>): Record<string, JsonValue> {
  return { actionId: action.actionId, functionId: action.functionId, pluginId: action.pluginId, idempotencyKey: action.idempotencyKey, input: action.input, ...extra };
}

/**
 * 在公开事件入口校验 Action 公共 Schema。
 * @param action - 未信任的 Action
 * @returns 无返回值，非法输入直接拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertAction(action: ActionDefinition): void {
  if (!validateContract('action', action).ok) throw new Error('Action 事件输入无效');
}

/**
 * 在公开事件入口校验 ActionResult 公共 Schema。
 * @param result - 未信任的 ActionResult
 * @returns 无返回值，非法输入直接拒绝
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function assertActionResult(result: ActionResult): void {
  if (!validateContract('actionResult', result).ok) throw new Error('ActionResult 事件输入无效');
}
