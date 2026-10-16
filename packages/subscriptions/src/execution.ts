/**
 * 提供单订阅执行的超时、重试、结果校验和审计报告构造。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { HandlerResult, HookHandler, HookSubscription, DispatchEvent, SubscriptionExecution } from './types.js';
import { isJsonValue, isPlainObject } from './json.js';

const MAX_ERROR_CODE_LENGTH = 256;
const STABLE_ERROR_CODES = new Set([
  'subscription.handler_missing',
  'subscription.handler_must_be_async',
  'subscription.handler_failed',
  'subscription.invalid_result',
  'subscription.invalid_decision',
  'subscription.invalid_reason',
  'subscription.invalid_patch'
]);

type ExecutionContext = {
  event: DispatchEvent;
  subscription: HookSubscription;
  startedAt: number;
  attempts: number;
  succeeded: boolean;
  blocked: boolean;
  result?: HandlerResult;
  errorCode?: string;
};

/** 表示 Handler 在规定时间内未完成且已触发取消信号。 */
export class SubscriptionTimeoutError extends Error {
  /**
   * 创建超时错误。
   *
   * @param timeoutMs - 超时毫秒数
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(timeoutMs: number) {
    super(`订阅处理超时：${timeoutMs}ms`);
    this.name = 'SubscriptionTimeoutError';
  }
}

/** 仅供运行时内部创建，用于携带受控错误码。 */
class InternalSubscriptionError extends Error {
  public readonly code: string;

  /**
   * 创建运行时内部错误。
   *
   * @param code - 受控错误码
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(code: string) {
    super(code);
    this.name = 'InternalSubscriptionError';
    this.code = code;
  }
}

/**
 * 执行处理器和有限重试，超时不再重试以避免不可取消副作用重复发生。
 *
 * @param event - 订阅事件
 * @param subscription - 订阅定义
 * @param handler - 可选处理器
 * @returns 执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function executeWithRetry(event: DispatchEvent, subscription: HookSubscription, handler: HookHandler | undefined): Promise<SubscriptionExecution> {
  const startedAt = Date.now();
  const maxRetries = subscription.retryPolicy?.maxRetries ?? 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const result = await invokeWithTimeout(event, subscription, handler);
      return createSuccessExecution(event, subscription, startedAt, attempt, result);
    } catch (error) {
      if (error instanceof SubscriptionTimeoutError || attempt > maxRetries) return createFailureExecution(event, subscription, startedAt, attempt, error);
      await wait(subscription.retryPolicy?.backoffMs ?? 0);
    }
  }
  return createFailureExecution(event, subscription, startedAt, maxRetries + 1, new Error('subscription.incomplete'));
}

/**
 * 调用异步 Handler 并校验动态返回值。
 *
 * @param event - 订阅事件
 * @param subscription - 订阅定义
 * @param handler - 已解析处理器
 * @returns 合法处理器结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function invokeWithTimeout(event: DispatchEvent, subscription: HookSubscription, handler: HookHandler | undefined): Promise<HandlerResult> {
  if (!handler) throw new InternalSubscriptionError('subscription.handler_missing');
  const controller = new AbortController();
  const operation = Promise.resolve().then(() => {
    const result = handler(event, subscription, controller.signal);
    if (!(result instanceof Promise)) throw new InternalSubscriptionError('subscription.handler_must_be_async');
    return result;
  });
  const result = await withTimeout(operation, subscription.timeoutMs ?? 5000, controller);
  return validateHandlerResult(result);
}

/**
 * 对 Handler Promise 设置整体超时并发出取消信号。
 *
 * @param operation - 待限制的异步操作
 * @param timeoutMs - 整体超时毫秒数
 * @param controller - 当前尝试的取消控制器
 * @returns 原操作结果或超时错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function withTimeout(operation: Promise<unknown>, timeoutMs: number, controller: AbortController): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SubscriptionTimeoutError(timeoutMs));
    }, timeoutMs);
    operation.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof InternalSubscriptionError ? error : new InternalSubscriptionError('subscription.handler_failed'));
    });
  });
}

/**
 * 校验动态 Handler 返回值，避免非法结果绕过 fail-closed。
 *
 * @param result - 未信任 Handler 返回值
 * @returns 通过校验的处理结果
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateHandlerResult(result: unknown): HandlerResult {
  if (!isPlainObject(result)) throw new InternalSubscriptionError('subscription.invalid_result');
  if (result.decision !== undefined && result.decision !== 'allow' && result.decision !== 'deny') throw new InternalSubscriptionError('subscription.invalid_decision');
  if (result.reasonCode !== undefined && (typeof result.reasonCode !== 'string' || result.reasonCode.length > MAX_ERROR_CODE_LENGTH)) throw new InternalSubscriptionError('subscription.invalid_reason');
  if (result.patch !== undefined && !isJsonValue(result.patch)) throw new InternalSubscriptionError('subscription.invalid_patch');
  return result as HandlerResult;
}

/**
 * 等待下一次重试，零退避保持测试和本地执行确定性。
 *
 * @param backoffMs - 退避毫秒数
 * @returns 等待完成 Promise
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function wait(backoffMs: number): Promise<void> {
  return backoffMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, backoffMs));
}

/**
 * 生成成功执行报告，并仅允许同步 before Hook 参与阻断。
 *
 * @param event - 订阅事件
 * @param subscription - 订阅定义
 * @param startedAt - 开始时间戳
 * @param attempts - 实际尝试次数
 * @param result - 处理器结果
 * @returns 成功执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createSuccessExecution(event: DispatchEvent, subscription: HookSubscription, startedAt: number, attempts: number, result: HandlerResult): SubscriptionExecution {
  const denied = subscription.delivery === 'sync' && subscription.allowDecision !== false && result.decision === 'deny';
  return createExecution({ event, subscription, startedAt, attempts, succeeded: true, blocked: denied, result });
}

/**
 * 生成失败报告，并按同步 Hook 的失败策略决定是否阻断。
 *
 * @param event - 订阅事件
 * @param subscription - 订阅定义
 * @param startedAt - 开始时间戳
 * @param attempts - 实际尝试次数
 * @param error - 原始异常
 * @returns 失败执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createFailureExecution(event: DispatchEvent, subscription: HookSubscription, startedAt: number, attempts: number, error: unknown): SubscriptionExecution {
  const blocked = subscription.delivery === 'sync' && subscription.failurePolicy === 'fail-closed';
  const errorCode = classifyError(error);
  return createExecution({ event, subscription, startedAt, attempts, succeeded: false, blocked, errorCode });
}

/**
 * 将异常映射到固定错误码白名单，拒绝透传 Handler 自定义消息。
 *
 * @param error - 当前异常
 * @returns 稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function classifyError(error: unknown): string {
  if (error instanceof SubscriptionTimeoutError) return 'subscription.timeout';
  if (error instanceof InternalSubscriptionError && STABLE_ERROR_CODES.has(error.code)) return error.code;
  return 'subscription.handler_failed';
}

/**
 * 统一构造订阅执行报告，避免成功与失败路径遗漏审计字段。
 *
 * @param context - 执行上下文，包含审计字段和结果状态
 * @returns 执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function createExecution(context: ExecutionContext): SubscriptionExecution {
  return {
    eventId: context.event.eventId,
    subscriptionId: context.subscription.subscriptionId,
    handlerRef: context.subscription.handler.ref,
    correlationId: context.event.correlationId,
    durationMs: Date.now() - context.startedAt,
    attempts: context.attempts,
    succeeded: context.succeeded,
    skipped: false,
    blocked: context.blocked,
    ...(context.result ? { result: context.result } : {}),
    ...(context.errorCode ? { error: context.errorCode, errorCode: context.errorCode } : {})
  };
}

/**
 * 生成异步队列发生意外异常时的稳定报告。
 *
 * @param eventId - 事件标识
 * @returns 不阻断主流程的失败报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function unexpectedDispatchFailure(eventId: string): import('./types.js').DispatchReport {
  return { eventId, executions: [], allowed: true, blocked: false, rejected: false, reason: 'dispatch_failed' };
}

/**
 * 生成单订阅意外异常的稳定失败结果。
 *
 * @param event - 订阅事件
 * @param subscription - 当前订阅
 * @returns 已完成的失败执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function unexpectedExecutionFailure(event: DispatchEvent, subscription: HookSubscription): SubscriptionExecution {
  return createExecution({
    event,
    subscription,
    startedAt: Date.now(),
    attempts: 0,
    succeeded: false,
    blocked: subscription.delivery === 'sync' && subscription.failurePolicy === 'fail-closed',
    errorCode: 'subscription.internal_failure'
  });
}

/**
 * 生成幂等容量耗尽时的稳定失败结果。
 *
 * @param event - 订阅事件
 * @param subscription - 当前订阅
 * @returns 容量拒绝执行报告
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export function idempotencyCapacityFailure(event: DispatchEvent, subscription: HookSubscription): SubscriptionExecution {
  return createExecution({
    event,
    subscription,
    startedAt: Date.now(),
    attempts: 0,
    succeeded: false,
    blocked: subscription.delivery === 'sync' && subscription.failurePolicy === 'fail-closed',
    errorCode: 'subscription.idempotency_capacity'
  });
}
