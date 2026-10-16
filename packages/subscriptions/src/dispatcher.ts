/**
 * 执行同步 before Hook 和异步 StateEvent 订阅，并提供超时、重试、幂等和递归边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { isKnownEventName } from './events.js';
import { executeWithRetry, idempotencyCapacityFailure, unexpectedExecutionFailure } from './execution.js';
import { isJsonValue, isPlainObject } from './json.js';
import { deferredDispatch } from './queue.js';
import { SubscriptionRegistry } from './registry.js';
import type {
  DispatchAcceptance,
  DispatchEvent,
  DispatchReport,
  DerivedEventInput,
  DispatcherOptions,
  HookHandler,
  HookSubscription,
  SubscriptionExecution
} from './types.js';

const DEFAULT_RECURSION_DEPTH = 3;
const DEFAULT_QUEUE_SIZE = 1000;
const DEFAULT_IDEMPOTENCY_ENTRIES = 10000;

type IdempotencyEntry = {
  promise: Promise<SubscriptionExecution>;
};

/**
 * 在订阅注册表上提供统一的 Hook/StateEvent 调度入口。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class SubscriptionDispatcher {
  private readonly handlers = new Map<string, HookHandler>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly pending: Promise<DispatchReport>[] = [];
  private readonly maxRecursionDepth: number;
  private readonly maxQueueSize: number;
  private readonly maxIdempotencyEntries: number;
  private outstandingDispatches = 0;

  /**
   * 创建调度器并校验资源边界。
   *
   * @param registry - 订阅注册表
   * @param options - 调度器运行时配置
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(private readonly registry: SubscriptionRegistry, options: DispatcherOptions = {}) {
    this.maxRecursionDepth = options.maxRecursionDepth ?? DEFAULT_RECURSION_DEPTH;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_QUEUE_SIZE;
    this.maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_IDEMPOTENCY_ENTRIES;
    validateDispatcherOptions(this.maxRecursionDepth, this.maxQueueSize, this.maxIdempotencyEntries);
  }

  /**
   * 注册一个异步处理器引用，引用由订阅 handler.ref 解析。
   *
   * @param ref - 处理器稳定引用
   * @param handler - 必须返回 Promise 的处理器实现
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public registerHandler(ref: string, handler: HookHandler): void {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('subscription.handler_ref_invalid');
    if (typeof handler !== 'function') throw new Error('subscription.handler_invalid');
    this.handlers.set(ref, handler);
  }

  /**
   * 串行执行 before Hook；高优先级拒绝会立即停止后续订阅。
   *
   * @param event - 待处理事件
   * @returns 包含阻断结果和每次执行证据的报告
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async runBefore(event: DispatchEvent): Promise<DispatchReport> {
    const rejection = validateEvent(event, this.maxRecursionDepth);
    if (rejection) return rejectedReport(eventIdOf(event), rejection);
    const executions: SubscriptionExecution[] = [];
    for (const subscription of this.registry.matching(event, 'sync')) {
      const execution = await this.execute(event, subscription);
      executions.push(execution);
      if (execution.blocked) return report(event.eventId, executions, false, true, false);
    }
    return report(event.eventId, executions, true, false, false);
  }

  /**
   * 将异步 StateEvent 放入有界队列，并把执行推迟到当前调用栈之后。
   *
   * @param event - 待异步投递事件
   * @returns 入队接受结果；未知事件、递归超限或队列满时拒绝
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public enqueue(event: DispatchEvent): DispatchAcceptance {
    const rejection = validateEvent(event, this.maxRecursionDepth);
    if (rejection) return { accepted: false, rejected: true, reason: rejection };
    if (this.outstandingDispatches >= this.maxQueueSize) return { accepted: false, rejected: true, reason: 'queue_full' };
    const subscriptions = this.registry.matching(event, 'async');
    if (subscriptions.length === 0) return { accepted: true, rejected: false };
    this.outstandingDispatches += 1;
    const task = deferredDispatch(() => this.dispatchAsync(event, subscriptions), event.eventId);
    this.pending.push(task);
    return { accepted: true, rejected: false };
  }

  /**
   * 立即发布异步订阅并返回聚合报告，适用于需要观测投递结果的调用方。
   *
   * @param event - 待异步发布事件
   * @returns 异步订阅执行报告
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async publish(event: DispatchEvent): Promise<DispatchReport> {
    const rejection = validateEvent(event, this.maxRecursionDepth);
    if (rejection) return rejectedReport(eventIdOf(event), rejection);
    return this.dispatchAsync(event, this.registry.matching(event, 'async'));
  }

  /**
   * 从父事件派生事件，自动增加递归深度并保留关联链路。
   *
   * @param parent - 父事件
   * @param input - 派生事件的标识、名称和载荷
   * @returns 带 causationId、递归深度和 correlationId 的新事件
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public deriveEvent(parent: DispatchEvent, input: DerivedEventInput): DispatchEvent {
    return { ...input, runId: parent.runId, correlationId: parent.correlationId, causationId: parent.eventId, recursionDepth: (parent.recursionDepth ?? 0) + 1 };
  }

  /**
   * 等待当前队列中的异步投递完成，并清空已消费的队列快照。
   *
   * @returns 当前队列的投递报告
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async drain(): Promise<DispatchReport[]> {
    const queued = this.pending.splice(0, this.pending.length);
    const reports = await Promise.all(queued);
    this.outstandingDispatches -= queued.length;
    return reports;
  }

  /**
   * 并发执行已匹配的异步订阅；异步结果不参与主动作阻断。
   *
   * @param event - 待处理事件
   * @param subscriptions - 已筛选订阅
   * @returns 聚合后的执行报告
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async dispatchAsync(event: DispatchEvent, subscriptions: HookSubscription[]): Promise<DispatchReport> {
    const executions = await Promise.all(subscriptions.map((subscription) => this.execute(event, subscription)));
    return report(event.eventId, executions, true, false, false);
  }

  /**
   * 执行单个订阅，并在调用 Handler 前登记幂等占位。
   *
   * @param event - 待处理事件
   * @param subscription - 当前订阅
   * @returns 单次订阅执行报告
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private execute(event: DispatchEvent, subscription: HookSubscription): Promise<SubscriptionExecution> {
    const key = JSON.stringify([event.eventId, subscription.subscriptionId]);
    const existing = this.idempotency.get(key);
    if (existing) return existing.promise.then((execution) => ({ ...execution, skipped: true }));
    if (this.idempotency.size >= this.maxIdempotencyEntries) return Promise.resolve(idempotencyCapacityFailure(event, subscription));
  const deferred = createDeferred<SubscriptionExecution>();
    const entry: IdempotencyEntry = { promise: deferred.promise };
    this.idempotency.set(key, entry);
    void executeWithRetry(event, subscription, this.handlers.get(subscription.handler.ref)).then(
      deferred.resolve,
      () => deferred.resolve(unexpectedExecutionFailure(event, subscription))
    );
    return entry.promise;
  }
}

/**
 * 校验 Dispatcher 的递归、队列和幂等容量配置。
 *
 * @param maxRecursionDepth - 最大递归深度
 * @param maxQueueSize - 最大待处理队列长度
 * @param maxIdempotencyEntries - 最大幂等结果数
 * @returns 无返回值；非法配置抛出错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateDispatcherOptions(maxRecursionDepth: number, maxQueueSize: number, maxIdempotencyEntries: number): void {
  const values = [maxRecursionDepth, maxQueueSize, maxIdempotencyEntries];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('Dispatcher 资源配置必须是非负安全整数');
  if (maxQueueSize === 0 || maxIdempotencyEntries === 0) throw new Error('Dispatcher 队列和幂等容量必须大于零');
}

/**
 * 校验事件外壳、JSON 载荷、事件字典和递归深度。
 *
 * @param event - 未信任事件输入
 * @param maxRecursionDepth - 最大递归深度
 * @returns 拒绝原因；合法时返回 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateEvent(event: unknown, maxRecursionDepth: number): 'unknown_event' | 'recursion_limit' | 'invalid_event' | undefined {
  if (!isPlainObject(event)) return 'invalid_event';
  const candidate = event as Partial<DispatchEvent>;
  if (!isNonEmptyString(candidate.eventId) || !isNonEmptyString(candidate.eventName) || !isNonEmptyString(candidate.runId) || !isNonEmptyString(candidate.correlationId) || !isJsonValue(candidate.payload)) return 'invalid_event';
  if (candidate.causationId !== undefined && !isNonEmptyString(candidate.causationId)) return 'invalid_event';
  if (!isKnownEventName(candidate.eventName)) return 'unknown_event';
  const depth = candidate.recursionDepth ?? 0;
  if (!Number.isSafeInteger(depth) || depth < 0) return 'invalid_event';
  return depth > maxRecursionDepth ? 'recursion_limit' : undefined;
}

/**
 * 创建可在异步执行完成后解析的占位 Promise。
 *
 * @returns 可延迟解析的对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

/**
 * 判断字符串是否非空。
 *
 * @param value - 待判断值
 * @returns 是否为非空字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 从未知事件输入中安全提取事件标识。
 *
 * @param event - 未信任事件输入
 * @returns 可用于拒绝报告的事件标识
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function eventIdOf(event: unknown): string {
  return isPlainObject(event) && typeof event.eventId === 'string' ? event.eventId : 'unknown-event';
}

/**
 * 判断值是否为普通 JSON 对象。
 *
 * @param value - 待判断值
 * @returns 是否为普通对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
/**
 * 聚合订阅执行报告。
 *
 * @param eventId - 事件标识
 * @param executions - 执行明细
 * @param allowed - 是否允许主流程继续
 * @param blocked - 是否被订阅阻断
 * @param rejected - 是否因输入边界拒绝
 * @returns 聚合报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function report(eventId: string, executions: SubscriptionExecution[], allowed: boolean, blocked: boolean, rejected: boolean): DispatchReport {
  return { eventId, executions, allowed, blocked, rejected };
}

/**
 * 生成稳定的拒绝报告。
 *
 * @param eventId - 事件标识
 * @param reason - 拒绝原因
 * @returns 拒绝报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function rejectedReport(eventId: string, reason: 'unknown_event' | 'recursion_limit' | 'invalid_event'): DispatchReport {
  return { eventId, executions: [], allowed: false, blocked: true, rejected: true, reason };
}
