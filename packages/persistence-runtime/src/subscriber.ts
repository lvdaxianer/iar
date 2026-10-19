/**
 * 把会话 StateEvent 异步投递到可替换 Persistence Provider。
 *
 * 该桥只依赖 Provider SPI 和订阅接口，不感知 SQLite、HTTP 或具体业务 Plugin。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
import type { EventEnvelope, EventName } from '@iar/contracts';
import {
  SubscriptionDispatcher,
  SubscriptionRegistry,
  type DispatchEvent,
  type HandlerResult,
  type HookHandler,
  type HookSubscription
} from '@iar/subscriptions';
import type {
  SessionIdentity,
  SessionMessage,
  SessionPersistenceProvider,
  SessionSnapshotRecord
} from '@iar/persistence-spi';

/** 由 Provider 订阅桥保存的状态事件集合。 */
const PERSISTENCE_EVENT_NAMES = [
  'message.received',
  'message.sent',
  'context.updated',
  'context.compacted',
  'session.restored',
  'action.completed',
  'action.failed'
] as const satisfies readonly EventName[];
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 25;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_OCCURRENCE_ENTRIES = 10000;

/** 订阅桥使用的 Provider 别名，强调其只依赖 SPI，不绑定具体实现。 */
export type PersistenceSubscriptionProvider = SessionPersistenceProvider;

/** 持久化订阅桥的可选运行时边界。 */
export type PersistenceSubscriptionOptions = {
  /** Provider 故障后的额外尝试次数。 */
  maxRetries?: number;
  /** 重试之间的固定退避时间。 */
  backoffMs?: number;
  /** 单次 Provider 调用的订阅超时。 */
  timeoutMs?: number;
  /** 订阅优先级；异步订阅不参与主流程阻断。 */
  priority?: number;
};

/** Provider 订阅桥的稳定配置或输入错误。 */
export class PersistenceSubscriptionError extends Error {
  /** @param code - 稳定错误码 @param message - 不包含消息正文和密钥的诊断信息 */
  public constructor(public readonly code: 'session_id_missing' | 'payload_invalid' | 'provider_invalid' | 'options_invalid', message: string) {
    super(message);
    this.name = 'PersistenceSubscriptionError';
  }
}

/**
 * 为 Provider 注册消息、上下文、恢复和动作结果的异步 StateEvent 订阅。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-19
 */
export class PersistenceSubscriptionBridge {
  private readonly options: Required<PersistenceSubscriptionOptions>;
  private readonly occurrenceByEventId = new Map<string, string>();
  private readonly handler: HookHandler;

  /** @param provider - 已初始化的 Persistence Provider @param options - 订阅重试与资源边界 */
  public constructor(private readonly provider: SessionPersistenceProvider, options: PersistenceSubscriptionOptions = {}) {
    if (!provider || typeof provider.appendEvent !== 'function' || typeof provider.appendMessage !== 'function' || typeof provider.saveSnapshot !== 'function') throw new PersistenceSubscriptionError('provider_invalid', 'Provider 不满足持久化订阅能力');
    this.options = normalizeOptions(options);
    this.handler = (event, _subscription, _signal) => this.persist(event);
  }

  /** 将所有受控事件注册到订阅表和异步处理器注册表。 */
  public install(registry: SubscriptionRegistry, dispatcher: SubscriptionDispatcher): readonly string[] {
    const ref = `iar.persistence.${this.provider.manifest.providerId}.write`;
    dispatcher.registerHandler(ref, this.handler);
    const subscriptionIds: string[] = [];
    for (const eventName of PERSISTENCE_EVENT_NAMES) {
      const subscriptionId = `${ref}.${eventName}`;
      const subscription: HookSubscription = {
        subscriptionId,
        event: eventName,
        handler: { type: 'builtin', ref },
        delivery: 'async',
        priority: this.options.priority,
        failurePolicy: 'fail-open',
        retryPolicy: { maxRetries: this.options.maxRetries, backoffMs: this.options.backoffMs },
        timeoutMs: this.options.timeoutMs
      };
      registry.register(subscription);
      subscriptionIds.push(subscriptionId);
    }
    return subscriptionIds;
  }

  /** 把一个受控 StateEvent 转换成 Provider 的消息/事件/快照写入。 */
  private async persist(event: DispatchEvent): Promise<HandlerResult> {
    if (typeof event.sessionId !== 'string' || event.sessionId.trim().length === 0) throw new PersistenceSubscriptionError('session_id_missing', '会话事件缺少 sessionId');
    const identity = this.identityOf(event);
    const envelope = this.eventOf(event);
    await this.provider.appendEvent(identity, envelope);
    if (event.eventName === 'message.received' || event.eventName === 'message.sent') {
      const message = readMessage(event.payload);
      await this.provider.appendMessage({ ...identity, messageId: message.messageId }, message);
    }
    if (event.eventName === 'context.updated' || event.eventName === 'context.compacted') {
      const snapshot = readSnapshot(event.payload, identity);
      if (snapshot) await this.provider.saveSnapshot(identity, snapshot);
    }
    return {};
  }

  /** 根据事件身份构造 Provider 身份；模型和业务 Plugin 不参与生成。 */
  private identityOf(event: DispatchEvent): SessionIdentity {
    return {
      sessionId: event.sessionId as string,
      runId: event.runId,
      traceId: event.traceId ?? event.correlationId,
      ...(event.messageId === undefined ? {} : { messageId: event.messageId })
    };
  }

  /** 生成可幂等写入的不可变事件外壳。 */
  private eventOf(event: DispatchEvent): EventEnvelope {
    return {
      schemaVersion: 'iar.event/v1',
      eventId: event.eventId,
      eventName: event.eventName as EventName,
      occurredAt: this.occurrenceOf(event),
      runId: event.runId,
      correlationId: event.correlationId,
      ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
      payload: event.payload
    };
  }

  /** 为旧事件调用方补齐稳定时间，确保重试不会造成 eventId 内容冲突。 */
  private occurrenceOf(event: DispatchEvent): string {
    const existing = this.occurrenceByEventId.get(event.eventId);
    if (existing) return existing;
    const occurredAt = event.occurredAt ?? new Date().toISOString();
    if (this.occurrenceByEventId.size >= MAX_OCCURRENCE_ENTRIES) {
      const oldest = this.occurrenceByEventId.keys().next().value;
      if (typeof oldest === 'string') this.occurrenceByEventId.delete(oldest);
    }
    this.occurrenceByEventId.set(event.eventId, occurredAt);
    return occurredAt;
  }
}

/** 校验并标准化订阅资源配置。 */
function normalizeOptions(options: PersistenceSubscriptionOptions): Required<PersistenceSubscriptionOptions> {
  const result = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    backoffMs: options.backoffMs ?? DEFAULT_BACKOFF_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    priority: options.priority ?? 100
  };
  if (!Number.isSafeInteger(result.maxRetries) || result.maxRetries < 0 || result.maxRetries > 10 || !Number.isSafeInteger(result.backoffMs) || result.backoffMs < 0 || result.backoffMs > 300000 || !Number.isSafeInteger(result.timeoutMs) || result.timeoutMs <= 0 || result.timeoutMs > 300000 || !Number.isSafeInteger(result.priority)) throw new PersistenceSubscriptionError('options_invalid', '持久化订阅配置无效');
  return result;
}

/** 从消息事件载荷读取可持久化消息。 */
function readMessage(payload: unknown): SessionMessage {
  if (!isRecord(payload) || !isRecord(payload.message) || typeof payload.message.messageId !== 'string' || typeof payload.message.content !== 'string' || typeof payload.message.occurredAt !== 'string' || !isRole(payload.message.role)) throw new PersistenceSubscriptionError('payload_invalid', '消息事件载荷无效');
  return payload.message as unknown as SessionMessage;
}

/** 从上下文事件载荷读取可选快照，并核对会话和运行身份。 */
function readSnapshot(payload: unknown, identity: SessionIdentity): SessionSnapshotRecord | undefined {
  if (!isRecord(payload) || payload.snapshot === undefined) return undefined;
  if (!isRecord(payload.snapshot) || payload.snapshot.sessionId !== identity.sessionId || payload.snapshot.runId !== identity.runId || typeof payload.snapshot.eventId !== 'string' || !Number.isSafeInteger(payload.snapshot.revision) || !isRecord(payload.snapshot.context)) throw new PersistenceSubscriptionError('payload_invalid', '上下文事件载荷无效');
  return payload.snapshot as unknown as SessionSnapshotRecord;
}

/** 判断消息角色是否落在 Provider SPI 的固定词表。 */
function isRole(value: unknown): value is SessionMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system';
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
