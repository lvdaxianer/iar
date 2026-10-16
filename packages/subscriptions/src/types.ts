/**
 * 定义 Hook 与 StateEvent 订阅调度使用的稳定类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';

/** 订阅投递方式；before Hook 必须同步串行，StateEvent 默认异步。 */
export type SubscriptionDelivery = 'sync' | 'async';

/** 订阅失败后的主流程处理策略。 */
export type SubscriptionFailurePolicy = 'fail-open' | 'fail-closed';

/** 订阅处理器的实现类型，具体加载边界由宿主负责。 */
export type HookHandlerType = 'builtin' | 'plugin' | 'webhook' | 'queue' | 'callback';

/** 事件过滤器支持精确匹配和有限集合匹配。 */
export type SubscriptionFilter = Record<string, {
  // equals 表示字段的结构化精确匹配。
  equals?: JsonValue;
  // in 表示字段值必须落在有限允许集合中。
  in?: JsonValue[];
}>;

/** 失败重试策略，maxRetries 不含第一次尝试。 */
export type RetryPolicy = {
  // maxRetries 只计算第一次失败后的额外尝试次数。
  maxRetries: number;
  // backoffMs 限制相邻尝试之间的等待时间。
  backoffMs: number;
};

/** 由宿主注册的 Hook 处理器函数。 */
export type HookHandler = (
  event: DispatchEvent,
  subscription: HookSubscription,
  signal: AbortSignal
) => Promise<HandlerResult>;

/** 处理器返回的可审计结果。 */
export type HandlerResult = {
  // decision 只在同步 before Hook 中具备阻断语义。
  decision?: 'allow' | 'deny';
  // reasonCode 供审计和调用方稳定识别原因。
  reasonCode?: string;
  // patch 是可选的、受 JSON 边界限制的上下文建议。
  patch?: JsonValue;
};

/** 送入订阅调度器的事件外壳。 */
export type DispatchEvent = {
  // eventId 是订阅幂等键的第一部分。
  eventId: string;
  // eventName 必须来自 Runtime 管理的事件字典。
  eventName: string;
  // runId 绑定一次可恢复运行。
  runId: string;
  // correlationId 贯穿派生事件和重试。
  correlationId: string;
  // payload 只能包含可重放 JSON。
  payload: JsonValue;
  // recursionDepth 防止事件触发事件形成无限循环。
  recursionDepth?: number;
  // causationId 指向触发当前事件的父事件。
  causationId?: string;
};

/** 一个可注册的内部 Hook 或 StateEvent 订阅。 */
export type HookSubscription = {
  // subscriptionId 是订阅幂等键的第二部分。
  subscriptionId: string;
  // event 是精确事件或 Runtime 允许的通配模式。
  event: string;
  // filter 在进入 Handler 前完成字段匹配。
  filter?: SubscriptionFilter;
  // handler 引用由宿主的 Handler 注册表解析。
  handler: { type: HookHandlerType; ref: string };
  // sync 用于 before Hook，async 用于 StateEvent。
  delivery: SubscriptionDelivery;
  // priority 越大越先执行。
  priority: number;
  // failurePolicy 决定同步 Hook 的失败是否阻断。
  failurePolicy: SubscriptionFailurePolicy;
  // retryPolicy 定义有限重试和退避。
  retryPolicy?: RetryPolicy;
  // timeoutMs 是每次 Handler 尝试的整体超时。
  timeoutMs?: number;
  // allowDecision 控制同步 Handler 是否允许返回 deny。
  allowDecision?: boolean;
  // enabled=false 时订阅被 Registry 跳过。
  enabled?: boolean;
};

/** 单个订阅执行的可审计报告。 */
export type SubscriptionExecution = {
  // 以下字段共同组成一条可重放的执行证据。
  eventId: string;
  subscriptionId: string;
  handlerRef: string;
  correlationId: string;
  durationMs: number;
  attempts: number;
  succeeded: boolean;
  skipped: boolean;
  blocked: boolean;
  result?: HandlerResult;
  error?: string;
  errorCode?: string;
};

/** 一次同步或异步事件投递的聚合报告。 */
export type DispatchReport = {
  eventId: string;
  executions: SubscriptionExecution[];
  allowed: boolean;
  blocked: boolean;
  rejected: boolean;
  reason?: 'unknown_event' | 'recursion_limit' | 'queue_full' | 'invalid_event' | 'dispatch_failed';
};

/** 调度器的运行时边界配置。 */
export type DispatcherOptions = {
  maxRecursionDepth?: number;
  maxQueueSize?: number;
  maxIdempotencyEntries?: number;
};

/** 异步入队的接受结果，避免未知事件和队列溢出被静默吞掉。 */
export type DispatchAcceptance = {
  accepted: boolean;
  rejected: boolean;
  reason?: 'unknown_event' | 'recursion_limit' | 'queue_full' | 'invalid_event' | 'dispatch_failed';
};

/** 派生事件使用的最小输入，递归和关联字段由 Dispatcher 自动填充。 */
export type DerivedEventInput = {
  eventId: string;
  eventName: string;
  payload: JsonValue;
};
