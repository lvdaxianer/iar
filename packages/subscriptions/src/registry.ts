/**
 * 管理订阅注册、启停、事件匹配和确定性优先级排序。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import { isKnownSubscriptionEvent } from './events.js';
import { isJsonValue, isPlainObject } from './json.js';
import type { DispatchEvent, HookSubscription } from './types.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RETRIES = 0;
const EMPTY_RETRY_BACKOFF_MS = 0;
const MAX_TIMER_MS = 300000;
const HANDLER_TYPES = ['builtin', 'plugin', 'webhook', 'queue', 'callback'] as const;
/** 表示订阅定义不满足运行时边界。 */
export class SubscriptionValidationError extends Error {
  /**
   * 创建订阅校验错误。
   *
   * @param message - 稳定的校验错误描述
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(message: string) {
    super(message);
    this.name = 'SubscriptionValidationError';
  }
}

/**
 * 维护订阅定义，并确保读取结果不会被调用方反向修改。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, HookSubscription>();

  /**
   * 注册一个新的订阅。
   *
   * @param subscription - 要登记的订阅定义
   * @returns 无返回值；重复标识或非法定义直接抛错
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public register(subscription: HookSubscription): void {
    validateSubscription(subscription);
    if (this.subscriptions.has(subscription.subscriptionId)) {
      throw new SubscriptionValidationError(`订阅已存在：${subscription.subscriptionId}`);
    }
    this.subscriptions.set(subscription.subscriptionId, normalizeSubscription(subscription));
  }

  /**
   * 删除订阅并返回是否确实删除。
   *
   * @param subscriptionId - 订阅稳定标识
   * @returns 是否存在并已删除
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public unregister(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /**
   * 切换订阅启用状态。
   *
   * @param subscriptionId - 订阅稳定标识
   * @param enabled - 是否启用
   * @returns 无返回值；未知订阅直接抛错
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public setEnabled(subscriptionId: string, enabled: boolean): void {
    const current = this.subscriptions.get(subscriptionId);
    if (!current) throw new SubscriptionValidationError(`订阅不存在：${subscriptionId}`);
    this.subscriptions.set(subscriptionId, { ...current, enabled });
  }

  /**
   * 返回匹配事件的订阅，按优先级降序和标识升序稳定排序。
   *
   * @param event - 待匹配事件
   * @param delivery - 可选的投递方式筛选
   * @returns 可执行订阅的隔离副本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public matching(event: DispatchEvent, delivery?: 'sync' | 'async'): HookSubscription[] {
    return [...this.subscriptions.values()]
      .filter((subscription) => subscription.enabled !== false)
      .filter((subscription) => delivery === undefined || subscription.delivery === delivery)
      .filter((subscription) => matchesEvent(subscription.event, event.eventName))
      .filter((subscription) => matchesFilter(subscription.filter, event.payload))
      .sort(compareSubscriptions)
      .map(normalizeSubscription);
  }

  /**
   * 读取指定订阅的隔离副本。
   *
   * @param subscriptionId - 订阅稳定标识
   * @returns 订阅副本；不存在时返回 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public get(subscriptionId: string): HookSubscription | undefined {
    const subscription = this.subscriptions.get(subscriptionId);
    return subscription ? normalizeSubscription(subscription) : undefined;
  }
}

/**
 * 校验订阅的输入边界和有限重试资源。
 *
 * @param subscription - 待校验订阅
 * @returns 无返回值；非法输入抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateSubscription(subscription: HookSubscription): void {
  if (!isPlainObject(subscription)) throw new SubscriptionValidationError('订阅定义必须是对象');
  if (!isNonEmptyString(subscription.subscriptionId) || !isNonEmptyString(subscription.event)) {
    throw new SubscriptionValidationError('订阅标识和事件名不能为空');
  }
  if (!isKnownSubscriptionEvent(subscription.event)) {
    throw new SubscriptionValidationError(`未知订阅事件：${subscription.event}`);
  }
  if (!isPlainObject(subscription.handler) || !isNonEmptyString(subscription.handler.ref)) throw new SubscriptionValidationError('订阅处理器引用不能为空');
  if (!HANDLER_TYPES.includes(subscription.handler.type)) throw new SubscriptionValidationError('订阅处理器类型无效');
  if (subscription.delivery !== 'sync' && subscription.delivery !== 'async') throw new SubscriptionValidationError('订阅投递方式无效');
  if (subscription.failurePolicy !== 'fail-open' && subscription.failurePolicy !== 'fail-closed') throw new SubscriptionValidationError('订阅失败策略无效');
  if (!Number.isSafeInteger(subscription.priority)) throw new SubscriptionValidationError('订阅优先级必须是安全整数');
  validateFilter(subscription.filter);
  validateRetryPolicy(subscription.retryPolicy);
  validateTimeout(subscription.timeoutMs);
}

/**
 * 判断值是否为非空字符串。
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
 * 校验重试次数和退避时间，避免无限重试占满调度资源。
 *
 * @param policy - 可选重试策略
 * @returns 无返回值；非法策略抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateRetryPolicy(policy: HookSubscription['retryPolicy']): void {
  if (policy !== undefined && !isPlainObject(policy)) throw new SubscriptionValidationError('重试策略必须是对象');
  const retries = policy?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoff = policy?.backoffMs ?? EMPTY_RETRY_BACKOFF_MS;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) throw new SubscriptionValidationError('订阅最大重试次数必须位于 0 到 10');
  if (!Number.isSafeInteger(backoff) || backoff < 0 || backoff > MAX_TIMER_MS) throw new SubscriptionValidationError('订阅退避时间必须位于 0 到 300000 毫秒');
}

/**
 * 校验处理超时，拒绝无限等待的 Handler。
 *
 * @param timeoutMs - 可选超时时间
 * @returns 无返回值；非法超时抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)) throw new SubscriptionValidationError('订阅超时必须位于 1 到 300000 毫秒');
}

/**
 * 校验过滤器结构，确保每个字段至少声明一种匹配方式。
 *
 * @param filter - 可选过滤器
 * @returns 无返回值；非法过滤器抛出稳定校验错误
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function validateFilter(filter: HookSubscription['filter']): void {
  if (filter === undefined) return;
  if (!isPlainObject(filter)) throw new SubscriptionValidationError('过滤器必须是对象');
  for (const condition of Object.values(filter)) {
    if (!isPlainObject(condition) || (condition.equals === undefined && condition.in === undefined)) {
      throw new SubscriptionValidationError('过滤条件必须包含 equals 或 in');
    }
    if (condition.equals !== undefined && !isJsonValue(condition.equals)) throw new SubscriptionValidationError('过滤条件 equals 必须是 JSON 值');
    if (condition.in !== undefined && (!Array.isArray(condition.in) || !isJsonValue(condition.in))) throw new SubscriptionValidationError('过滤条件 in 必须是 JSON 数组');
  }
}

/**
 * 补齐运行时默认值并复制嵌套过滤器。
 *
 * @param subscription - 已通过校验的订阅
 * @returns 可安全保存或返回的订阅副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function normalizeSubscription(subscription: HookSubscription): HookSubscription {
  const retryPolicy = subscription.retryPolicy ?? { maxRetries: DEFAULT_MAX_RETRIES, backoffMs: EMPTY_RETRY_BACKOFF_MS };
  return {
    ...subscription,
    handler: { ...subscription.handler },
    ...(subscription.filter ? { filter: cloneFilter(subscription.filter) } : {}),
    retryPolicy: { ...retryPolicy },
    timeoutMs: subscription.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    enabled: subscription.enabled !== false
  };
}

/**
 * 复制过滤器，阻止外部修改注册表内部集合。
 *
 * @param filter - 订阅过滤器
 * @returns 过滤器副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function cloneFilter(filter: NonNullable<HookSubscription['filter']>): NonNullable<HookSubscription['filter']> {
  return Object.fromEntries(Object.entries(filter).map(([key, condition]) => [key, {
    ...(condition.equals !== undefined ? { equals: cloneJson(condition.equals) } : {}),
    ...(condition.in !== undefined ? { in: condition.in.map(cloneJson) } : {})
  }])) as NonNullable<HookSubscription['filter']>;
}

/**
 * 判断订阅事件模式是否覆盖实际事件。
 *
 * @param pattern - 精确事件名或以 .* 结尾的前缀模式
 * @param eventName - 实际事件名
 * @returns 是否匹配
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchesEvent(pattern: string, eventName: string): boolean {
  return pattern === eventName || (pattern.endsWith('.*') && eventName.startsWith(pattern.slice(0, -1)));
}

/**
 * 判断事件载荷是否满足所有过滤条件。
 *
 * @param filter - 可选过滤器
 * @param payload - 事件载荷
 * @returns 是否满足过滤条件
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchesFilter(filter: HookSubscription['filter'], payload: JsonValue): boolean {
  if (!filter) return true;
  if (!isObject(payload)) return false;
  return Object.entries(filter).every(([key, condition]) => matchesCondition(payload[key], condition));
}

/**
 * 判断单个载荷字段的 equals/in 条件。
 *
 * @param value - 实际字段值
 * @param condition - 字段匹配条件
 * @returns 是否匹配
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function matchesCondition(value: JsonValue | undefined, condition: { equals?: JsonValue; in?: JsonValue[] }): boolean {
  const equalsMatch = condition.equals === undefined || isEqualJson(value, condition.equals);
  const inMatch = condition.in === undefined || condition.in.some((candidate) => isEqualJson(value, candidate));
  return equalsMatch && inMatch;
}

/**
 * 用稳定 JSON 表示比较两个 JSON 值。
 *
 * @param left - 左值
 * @param right - 右值
 * @returns 是否结构相等
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isEqualJson(left: JsonValue | undefined, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * 对 JSON 值做稳定序列化，避免对象键顺序影响过滤匹配。
 *
 * @param value - 待序列化 JSON 值
 * @returns 键排序后的 JSON 字符串
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function canonicalJson(value: JsonValue | undefined): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 深复制 JSON 值，隔离订阅注册时传入的嵌套结构。
 *
 * @param value - 待复制 JSON 值
 * @returns JSON 值副本
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T;
  }
  return value;
}

/**
 * 判断值是否为可按字段读取的 JSON 对象。
 *
 * @param value - 待判断值
 * @returns 是否为非空 JSON 对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 生成稳定的订阅执行顺序。
 *
 * @param left - 左侧订阅
 * @param right - 右侧订阅
 * @returns 排序比较值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function compareSubscriptions(left: HookSubscription, right: HookSubscription): number {
  return right.priority - left.priority || left.subscriptionId.localeCompare(right.subscriptionId);
}
