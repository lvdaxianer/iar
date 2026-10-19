/** 会话上下文压缩和失败事件记录。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { SCHEMA_VERSIONS, type BehaviorContext, type CompactionResult, type EventEnvelope } from '@iar/contracts';
import { ContextCompactorAdapter, type ModelGateway } from '@iar/decision';
import { BehaviorContextProjector, ContextCompactionService, type CompactionRequest } from '@iar/runtime';
import { InMemoryEventStore } from '../../../packages/storage/src/index.js';
import { resolveSandboxTraceId } from './safe-log.js';
import { SESSION_RUN_ID, SESSION_CORRELATION_ID } from './session-core.js';
import type { CompactResult } from './session-types.js';

/** 压缩组件所需的实时会话状态；重置后访问器指向新存储。
 * 组件没有单独生命周期，由宿主负责关闭网关和插件线程。
 * 调用者需保证对同一会话的压缩和其他状态操作串行。
 * 访问器只读取本次会话的状态，不跨会话共享。
 */
export type CompactionContext = {
  /** 每次读取最新事件存储，重置后不得使用旧对象。 */
  eventStore: InMemoryEventStore;
  /** 与事件存储同步的可信投影。 */
  projector: BehaviorContextProjector;
  /** 会话持有的模型网关。 */
  gateway: ModelGateway;
  /** 回复模型使用的有限消息缓存；压缩模型不会读取或传输它。 */
  recentMessages: Array<{ role: string; text: string }>;
  /** 访问宿主序号，避免组件保留重置前的副本。 */
  compactCount: number;
  /** 压缩事件投影后异步保存完整结构化快照。 */
  queueSnapshot: (eventId: string) => void;
  /** 将已追加的压缩事实发布给订阅桥；旧调用方可以省略。 */
  publishEvent?: (event: EventEnvelope) => void;
};

/** 会话上下文压缩和失败事件记录。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionCompaction {
  /** 保存实时访问器，不持有独立事件或投影副本。
   * @param context - 宿主会话提供的状态访问器
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public constructor(private readonly context: CompactionContext) {}
  /**
   * 触发一次上下文压缩：模型摘要 → 运行时校验 → 事件追加与投影。
   * 至少保留最后一个事件；事件不足时不请求模型。
   * 读取存储和投影后捕获本次快照，保证压缩边界一致。
   *
   * @returns 压缩结果，含压缩前后关键字段哈希
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async compact(): Promise<CompactResult> {
    const events = await this.context.eventStore.list();
    const current = this.context.projector.current();
    const hashBefore = current.integrity.criticalFieldHash;
    // 至少保留最后一个事件，事件不足时不调用模型。
    if (events.length < 2) {
      return { ok: false, reasonCode: 'insufficient_events', error: '事件不足两条，无法压缩。', hashBefore, hashAfter: hashBefore };
    }
    this.context.compactCount += 1;
    const compactSeq = this.context.compactCount;
    const occurredAt = new Date().toISOString();
    const compacted = await new ContextCompactorAdapter(this.context.gateway).compact({
      traceId: resolveSandboxTraceId(`trace-compact-${String(compactSeq)}`),
      runId: SESSION_RUN_ID,
      input: { behaviorContext: current, eventsToCompact: events.slice(0, -1) }
    });
    return this.finishCompaction({ events, current, hashBefore, compactSeq, occurredAt, compacted });
  }

  /** 记录模型或运行时压缩结果，失败时保留可验证的旧投影。
   * 模型失败和运行时校验失败分别产生稳定的失败事件。
   * 只有运行时接受结果时才应用新的压缩事件和上下文。
   * @param result - 本次压缩输入快照和模型响应
   * @returns 已投影事件及压缩状态
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  private async finishCompaction(result: { events: EventEnvelope[]; current: BehaviorContext; hashBefore: string; compactSeq: number; occurredAt: string; compacted: Awaited<ReturnType<ContextCompactorAdapter['compact']>> }): Promise<CompactResult> {
    const { events, current, hashBefore, compactSeq, occurredAt, compacted } = result;
    if (!compacted.ok) {
      // 模型调用失败时也记录失败事件，保留旧视图。
      const failureEvent = this.buildCompactionFailureEvent({ compactSeq, occurredAt, reasonCode: compacted.error.code, message: compacted.error.message, hashBefore });
      await this.context.eventStore.append(failureEvent);
      this.context.projector.apply(failureEvent);
      this.context.publishEvent?.(failureEvent);
      this.context.queueSnapshot(failureEvent.eventId);
      return { ok: false, reasonCode: compacted.error.code, error: compacted.error.message, hashBefore, hashAfter: this.context.projector.current().integrity.criticalFieldHash, eventId: failureEvent.eventId };
    }
    const outcome = new ContextCompactionService().compact(this.buildCompactionRequest({ compactSeq, occurredAt, events, current, compacted: compacted.value }));
    // 校验成功才应用压缩事件；失败事件保留旧上下文。
    if (outcome.ok) {
      await this.context.eventStore.append(outcome.event);
      this.context.projector.apply(outcome.event);
      this.context.publishEvent?.(outcome.event);
      this.context.queueSnapshot(outcome.event.eventId);
      return { ok: true, summary: compacted.value.summary, hashBefore, hashAfter: outcome.context.integrity.criticalFieldHash, eventId: outcome.event.eventId };
    }
    await this.context.eventStore.append(outcome.failureEvent);
    this.context.projector.apply(outcome.failureEvent);
    this.context.publishEvent?.(outcome.failureEvent);
    this.context.queueSnapshot(outcome.failureEvent.eventId);
    return { ok: false, reasonCode: outcome.error.code, error: outcome.error.message, hashBefore, hashAfter: this.context.projector.current().integrity.criticalFieldHash, eventId: outcome.failureEvent.eventId };
  }


  /**
   * 生成 CompactionRequest，token 数用 JSON 字符串长度估算。
   * 最后一个事件保留，其之前的事件构成待压缩区间。
   * 估算后的结果不得超过原始事件大小。
   *
   * @param result - 压缩序号、时间、事件、可信上下文及模型结果
   * @returns 压缩服务请求
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private buildCompactionRequest(result: { compactSeq: number; occurredAt: string; events: readonly EventEnvelope[]; current: BehaviorContext; compacted: CompactionResult }): CompactionRequest {
    const { compactSeq, occurredAt, events, current, compacted } = result;
    const beforeTokenCount = events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
    return {
      current,
      runId: SESSION_RUN_ID, correlationId: SESSION_CORRELATION_ID,
      occurredAt,
      compactedEventId: `sandbox-compacted-${String(compactSeq)}`,
      failureEventId: `sandbox-compaction-failed-${String(compactSeq)}`,
      events,
      result: compacted,
      fromEventId: events[0]!.eventId,
      toEventId: events[events.length - 2]!.eventId,
      firstKeptEntryId: events[events.length - 1]!.eventId,
      beforeTokenCount,
      afterTokenCount: Math.min(JSON.stringify({ summary: compacted.summary, state: compacted.state }).length, beforeTokenCount),
      summaryVersion: 'summary-v1',
      generatorVersion: 'sandbox-compactor-v1'
    };
  }


  /**
   * 模型压缩失败时手工构造 compaction_failed 事件。
   * 事件记录旧投影哈希，以便调用方验证失败前后关键字段不变。
   * 只保存稳定的错误分类和消息，不追加原始模型响应。
   * 失败事件沿用当前会话运行标识与关联标识。
   *
   * @param result - 序号、时间、失败分类及旧视图哈希
   * @returns 可追加的失败事件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private buildCompactionFailureEvent(result: { compactSeq: number; occurredAt: string; reasonCode: string; message: string; hashBefore: string }): EventEnvelope {
    const { compactSeq, occurredAt, reasonCode, message, hashBefore } = result;
    return {
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId: `sandbox-compaction-model-failed-${String(compactSeq)}`,
      eventName: 'context.compaction_failed',
      occurredAt,
      runId: SESSION_RUN_ID,
      correlationId: SESSION_CORRELATION_ID,
      payload: { reasonCode, message, previousContextHash: hashBefore }
    };
  }

}
