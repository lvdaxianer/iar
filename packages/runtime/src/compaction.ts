/**
 * 校验上下文压缩候选结果，并生成可交给 EventLog 追加的审计事件。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import {
  SCHEMA_VERSIONS,
  validateContract,
  type BehaviorContext,
  type CompactionEventPayload,
  type CompactionResult,
  type ContractErrorResult,
  type EventEnvelope
} from '@iar/contracts';
import { BehaviorContextProjector, createInitialContext, criticalFieldHash } from './context-projector.js';
import {
  compactionError,
  failureEventId,
  fallbackFailureEvent,
  issue,
  safeString
} from './compaction-helpers.js';
import { normalizeCompactionState, validateCompactionRequest } from './compaction-validation.js';

/** Runtime 为模型结果补齐的事件边界和审计字段。 */
export type CompactionRequest = {
  // current 是唯一可信的旧视图。
  current: BehaviorContext;
  // runId 绑定本次压缩的事件集合。
  runId: string;
  // correlationId 绑定同一业务链路。
  correlationId: string;
  // occurredAt 记录压缩审计时间。
  occurredAt: string;
  // compactedEventId 是成功事件的唯一 ID。
  compactedEventId: string;
  // failureEventId 是调用方期望的失败事件 ID。
  failureEventId: string;
  // events 是不可变输入事实的有序快照。
  events: readonly EventEnvelope[];
  // result 只包含模型负责的最小结构。
  result: CompactionResult;
  // 以下字段全部由 Runtime 补齐。
  fromEventId: string;
  toEventId: string;
  firstKeptEntryId: string;
  // token 计数用于压缩效果审计。
  beforeTokenCount: number;
  afterTokenCount: number;
  // 摘要和生成器版本必须可追溯。
  summaryVersion: string;
  generatorVersion: string;
};
// 请求字段顺序与审计事件生成顺序保持一致。

/** 成功事件的窄化类型，避免调用方重新解释 JSON 载荷。 */
export type CompactedEvent = Omit<EventEnvelope, 'eventName' | 'payload'> & {
  // 成功事件名称固定，防止调用方混淆失败路径。
  eventName: 'context.compacted';
  // payload 使用专用的完整状态 Schema。
  payload: CompactionEventPayload;
};

/** 失败事件的稳定载荷类型。 */
export type CompactionFailedEventPayload = {
  // reasonCode 供程序化统计和重试策略使用。
  reasonCode: string;
  // message 不包含底层异常堆栈。
  message: string;
  // previousContextHash 证明旧视图未被替换。
  previousContextHash: string;
};

/** 失败事件的窄化类型。 */
export type CompactionFailedEvent = Omit<EventEnvelope, 'eventName' | 'payload'> & {
  // 失败事件名称固定为审计事件。
  eventName: 'context.compaction_failed';
  // 失败载荷不携带模型候选状态。
  payload: CompactionFailedEventPayload;
};

/** 上下文压缩服务返回的显式成功或失败结果。 */
export type CompactionOutcome =
  // 成功分支只返回已通过哈希和事件 Schema 的结果。
  | { ok: true; context: BehaviorContext; event: CompactedEvent }
  // 失败分支始终携带旧视图和可追加失败事件。
  | { ok: false; context: BehaviorContext; failureEvent: CompactionFailedEvent; error: ContractErrorResult };
// 联合类型要求调用方显式处理失败，不会把失败当成空成功。

/**
 * 执行模型候选的 Schema、状态、引用和事件边界校验。
 *
 * 该服务只负责校验和规划事件；调用方必须把返回事件追加到 EventLog。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ContextCompactionService {
  /**
   * 校验候选结果并返回新上下文和待追加事件。
   *
   * @param request - 当前可信状态、模型结果和 Runtime 审计元数据
   * @returns 成功压缩事件或保留旧视图的失败事件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public compact(request: CompactionRequest): CompactionOutcome {
    // 先验证旧状态，避免错误候选覆盖不可恢复视图。
    const trusted = this.createTrustedProjector(request.current);
    // trusted.projector.current() 始终返回深拷贝。
    // 非法旧状态只能返回稳定基线和失败事件。
    if (!trusted.ok) return this.failure(request, this.fallbackContext(request), trusted.error);
    // 模型 Schema 和 Runtime 元数据必须全部通过。
    const validation = validateCompactionRequest(request);
    // 失败事件不会使用未经验证的 candidate。
    // 校验失败时继续返回原始投影副本。
    if (!validation.ok) return this.failure(request, trusted.projector.current(), validation.error);
    // 模型片段只允许合并到可信状态的既有字段。
    const candidate = normalizeCompactionState(request.result.state, trusted.projector.current());
    // 关键字段哈希是最终不可绕过的执行状态门禁。
    const replacement = trusted.projector.replaceIfIntegrityMatches(candidate);
    // 任一关键字段变化都不能推进 Workflow。
    if (!replacement.ok) return this.failure(request, trusted.projector.current(), replacement.error);
    // 成功压缩只更新恢复边界，不修改可执行关键字段。
    const context = this.withCompactionBoundary(replacement.value, request.compactedEventId);
    // context 是新的成功快照，旧快照仍由 projector 保持。
    // Runtime 负责构造而不是信任模型的事件元数据。
    const event = this.createCompactedEvent(request, context);
    // 事件载荷必须通过通用 Envelope 和专用 payload Schema。
    const eventValidation = validateContract('event', event);
    if (!eventValidation.ok) return this.failure(request, trusted.projector.current(), eventValidation.error);
    return { ok: true, context, event };
  }
  // compact 只规划事件，由上层 EventStore 负责追加。
  // 这样可以由上层事务决定事件和快照的提交顺序。
  // 本服务不隐藏任何异步持久化副作用。

  /** 创建可信投影器，非法旧视图由调用方决定是否中止本次运行。 */
  private createTrustedProjector(current: BehaviorContext):
    | { ok: true; projector: BehaviorContextProjector }
    | { ok: false; error: ContractErrorResult } {
    try {
      // Projector 构造器同时验证完整 Schema 和关键字段哈希。
      // 这一步不接受模型候选作为可信输入。
      return { ok: true, projector: new BehaviorContextProjector(current) };
    } catch {
      // 不把底层异常消息泄露到稳定错误边界。
      return { ok: false, error: compactionError([issue('/current', 'state', '当前 BehaviorContext 无效')]) };
    }
  }
  // Projector 是失败时旧视图保持不变的状态容器。
  // Projector 也负责校验 candidate 的完整 BehaviorContext。

  /** 把成功压缩事件设置为新的恢复边界，但不改变关键字段哈希。 */
  private withCompactionBoundary(context: BehaviorContext, eventId: string): BehaviorContext {
    // 先复制状态，避免修改 Projector 已保存的快照。
    const next = structuredClone(context);
    // 旧对象继续作为失败路径的快照。
    // 压缩事件成为后续恢复时可见的最后事件。
    next.integrity.lastEventId = eventId;
    // 元数据变化不属于关键字段，因此哈希仍可稳定复算。
    next.integrity.criticalFieldHash = criticalFieldHash(next);
    return next;
  }

  /** 创建完全脱离候选对象引用的成功事件。 */
  private createCompactedEvent(request: CompactionRequest, context: BehaviorContext): CompactedEvent {
    // 载荷独立构造，禁止复用模型对象引用。
    const payload = this.createCompactionPayload(request, context);
    // EventEnvelope 的公共字段全部由请求上下文提供。
    return {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: request.compactedEventId,
      eventName: 'context.compacted',
      occurredAt: request.occurredAt,
      runId: request.runId,
      correlationId: request.correlationId,
      causationId: request.toEventId,
      payload
    };
  }
  // 返回事件可由上层通过 append 或 appendAll 持久化。
  // EventStore 的原子性由 storage 包的实现负责。

  /** 构造与模型结果完全隔离的成功载荷。 */
  private createCompactionPayload(request: CompactionRequest, context: BehaviorContext): CompactionEventPayload {
    // 只从 Runtime 请求读取边界和计数。
    const result = request.result;
    // 模型只贡献摘要、引用、事实声明和警告。
    return {
      fromEventId: request.fromEventId,
      toEventId: request.toEventId,
      firstKeptEntryId: request.firstKeptEntryId,
      summary: result.summary,
      summaryVersion: request.summaryVersion,
      state: structuredClone(context),
      // state 与返回 context 完全断开引用。
      references: structuredClone(result.references),
      // 数组复制保证事件不可变审计。
      preservedFacts: structuredClone(result.preservedFacts),
      warnings: structuredClone(result.warnings),
      // Runtime 元数据从 request 读取，模型没有覆盖权。
      beforeTokenCount: request.beforeTokenCount,
      afterTokenCount: request.afterTokenCount,
      generatorVersion: request.generatorVersion,
      criticalFieldHash: context.integrity.criticalFieldHash
    };
  }

  /** 创建失败事件并统一复用公共 EventEnvelope 校验。 */
  private failure(request: CompactionRequest, context: BehaviorContext, error: ContractErrorResult): CompactionOutcome {
    // 失败事件也使用独立的、不会碰撞输入的 ID。
    const failureEvent: CompactionFailedEvent = {
      // 失败事件不携带模型 state，避免失败候选被误用。
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: failureEventId(request, context),
      eventName: 'context.compaction_failed',
      occurredAt: safeString(request.occurredAt, '1970-01-01T00:00:00.000Z'),
      runId: safeString(request.runId, 'unknown-run'),
      correlationId: safeString(request.correlationId, 'unknown-correlation'),
      payload: {
        // reasonCode 是唯一供机器消费的失败分类。
        reasonCode: error.code,
        message: error.message,
        previousContextHash: context.integrity.criticalFieldHash
      }
    };
    // 失败路径必须和成功路径一样校验 EventEnvelope。
    const validation = validateContract('event', failureEvent);
    // 固定兜底事件再次通过公共校验后才返回。
    if (!validation.ok) return { ok: false, context: structuredClone(context), failureEvent: fallbackFailureEvent(context), error };
    return { ok: false, context: structuredClone(context), failureEvent, error };
  }
  // 调用方可安全地把 failureEvent 追加到 EventLog。

  /** 当前视图非法时提供不抛异常的稳定失败基线。 */
  private fallbackContext(request: CompactionRequest): BehaviorContext {
    // 只有旧视图本身损坏时才使用这个最小基线。
    return createInitialContext(safeString(request.runId, 'unknown-run'));
  }

  // 正常路径永远不会使用 fallbackContext。
  // 它只保证损坏旧视图不导致裸异常。
  // 返回的基线仍然满足 BehaviorContext Schema。

}
