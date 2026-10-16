/**
 * 实现三种 executor 共用的能力、资源和生命周期核心。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { HookSubscription } from '@iar/subscriptions';
import { EXECUTOR_PROTOCOL_VERSION, type CleanupReport, type CredentialScope, type ExecutorError, type ExecutorHandler, type ExecutorMode, type ExecutorOptions, type ExecutorRequest, type ExecutorResponse, type PluginExecutor } from './types.js';
import { executorError, isJsonValue, normalizeOptions, validateRequest } from './validation.js';

type ActiveRequest = { request: ExecutorRequest; controller: AbortController; promise: Promise<ExecutorResponse>; abortReject?: () => void; abortKind?: 'timeout' | 'cancelled' };
type NormalizedOptions = ReturnType<typeof normalizeOptions>;

/*
 * ConstrainedExecutor 是三个 mode 的唯一状态机实现。
 * adapter 只能选择 mode，不能改变校验、timeout 或 cleanup 顺序。
 * active map 保存请求和 AbortController，不保存输入或输出 secret。
 * credentialScopes 只保存 tenant/plugin/version，不保存 resolver 返回值。
 * execute 先校验，再检查 close 和 duplicate，最后登记 active request。
 * run 先校验 credential scope，再建立 abort race。
 * timeout 和 cancel 都通过同一个 abort 方法完成。
 * 第一个 abort 原因获胜，后续 abort 不覆盖审计语义。
 * handler 结果在返回前再次进行 JSON 和 output budget 校验。
 * handler 抛异常只转换为稳定 executor.handler_failed。
 * timeout 的 retryable 为 true，cancel 和 resource limit 为 false。
 * finally 清理 timer，finish 清理 active 和 credential scope。
 * late handler 结果即使完成，也无法重新写入 response。
 * close 会先标记 closed，再取消并等待当前请求。
 * close 后新请求返回 executor.closed。
 * duplicate request 不会创建第二个 handler 调用。
 * cleanupPlugin 只匹配同一 tenant 和 plugin。
 * cleanupPlugin 等待取消结果，再处理订阅 registry。
 * subscriptionOwner 异常按不拥有处理。
 * subscriptionIds 异常按无可回收订阅处理。
 * removeSubscriptions 保持另一个 plugin 的订阅不变。
 * 所有返回 ID 都排序，保证 deterministic evidence。
 * 该核心不启动外部 Worker、Sidecar 或容器进程。
 * 真实进程 transport 可在后续部署任务中替换薄 adapter。
 * validateExecution 只返回稳定错误，不抛出外部输入。
 * closed 检查位于 active 登记之前。
 * duplicate 检查保证同一 requestId 不并发执行两次。
 * active entry 先登记再启动 run，保证 cancel 没有竞态空窗。
 * credential resolver 的返回值只被比较 undefined。
 * credential resolver throw 不向调用者传播。
 * timeout timer 使用 request 和 executor 两级最小值。
 * AbortExecutionError 不暴露给 response。
 * invalid handler result 不进入 success data。
 * output budget 在 result schema 通过后检查。
 * handler failure 不回显 Error.message。
 * timer 在每条 run 路径 finally 中清除。
 * finish 只删除仍指向当前 entry 的 active 值。
 * late completion 不会删除后续同 ID 的 entry。
 * cancel 对 unknown request 返回 false 而不抛异常。
 * close 对空 active map 也是幂等的。
 * cleanupPlugin 返回前等待所有取消结果。
 * cleanupPlugin 不自动删除未经 owner callback 确认的订阅。
 * registry.unregister 的 false 结果不会伪造 removed ID。
 * report 排序保证跨 mode 的审计一致性。
 * jsonBytes 序列化失败按无限资源处理。
 * isHandlerResult 拒绝继承对象和数组。
 * 本地 JSON 判断避免引入额外 runtime 依赖。
 * failure envelope 保留 request 的追踪字段。
 * success envelope 保留 HandlerResult 的 status/output。
 * AbortExecutionError 只在核心内部使用。
 * mode factory 不会重写 request.pluginVersion。
 * options.version 是可信部署配置而非请求字段。
 * allowedCapabilities 的 Set 只用于精确查找。
 * input byte limit 早于 credential resolver 执行。
 * credential resolver 不能读取其他 tenant scope。
 * resolver ref 按请求声明逐个解析。
 * resolver 不返回 secret 给 handler，防止 accidental echo。
 * request context 的 runId 使用 requestId 形成稳定关联。
 * traceId 原样传递到 PluginHandlerContext。
 * timer 和 abort race 共享同一个 entry。
 * handler promise 的 late settlement 被忽略。
 * output data 经过 schema 和 bytes 两次边界检查。
 * fail-open observer 不在本 executor 内实现。
 * executor 不负责 PluginHost 生命周期状态变更。
 * executor 不负责 Workflow event 写入。
 * executor 不负责订阅匹配或重试策略。
 * subscription cleanup 只做显式 ID 回收。
 * owner callback 可以结合 tenant、plugin 和外部版本表。
 * cleanup report 不包含 subscription 内容。
 * close 不会删除 subscription registry 记录。
 * plugin cleanup 才会触发订阅注销。
 * 多次 cleanup 同一 plugin 返回空的后续报告。
 * active request map 是实例私有状态。
 * 不同 mode 实例之间不共享活动请求。
 * 不同 tenant 的 request 不会互相取消。
 * 不同 plugin 的 cleanup 不会互相取消。
 * requestId 只能有一个活动 entry。
 * stable error code 供 Service/Sidecar 转发。
 * error message 不包含用户输入。
 * retryable 只表达重新调度建议。
 * timeout 结束后仍需等待 handler race 返回。
 * cancel 不会强杀 JS 执行栈，只阻止结果采纳。
 * 外部 adapter 可在此基础上接入真实 IPC。
 * 当前实现保持 deterministic local fixture。
 * prepareRequest 让 failure 路径也能处理 null。
 * safeString 防止恶意 getter 传播异常。
 * request snapshot 与调用方对象解除引用。
 * capabilities 和 credentialRefs 都复制为冻结数组。
 * input snapshot 使用 structuredClone 再递归冻结。
 * handler result snapshot 与 request snapshot 使用同一策略。
 * invalid result 不会进入 active completion data。
 * cleanup preflight 完成后才开始 unregister。
 * unregister 部分失败尝试恢复原订阅。
 * registry 异常被转换为无清理结果而不抛出。
 * 安全边界优先于最佳清理数量。
 * 这些分支都不输出敏感字段。
 * failure metadata 读取不信任调用方对象。
 * stable request 成功后才会触碰 active map。
 * close 与 cleanup 都等待 race 结束。
 * timeout timer 不跨越 response 生命周期。
 * abort reason 一经设置不会被覆盖。
 * response mode 始终来自实例而非 request。
 * pluginVersion 始终来自冻结 request。
 * 所有异常分支都返回 ExecutorResponse。
 */

/** @param request - 未知请求 @param mode - 执行模式 @param error - 稳定错误 @returns 失败响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
function failure(request: unknown, mode: ExecutorMode, error: ExecutorError): ExecutorResponse {
  return { protocolVersion: EXECUTOR_PROTOCOL_VERSION, requestId: safeString(request, 'requestId'), traceId: safeString(request, 'traceId'), pluginId: safeString(request, 'pluginId'), pluginVersion: safeString(request, 'pluginVersion'), mode, data: null, error };
}

/** @param request - 已冻结请求 @param mode - 执行模式 @param data - 已验证结果 @returns 成功响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
function success(request: ExecutorRequest, mode: ExecutorMode, data: NonNullable<ExecutorResponse['data']>): ExecutorResponse {
  return { protocolVersion: EXECUTOR_PROTOCOL_VERSION, requestId: request.requestId, traceId: request.traceId, pluginId: request.pluginId, pluginVersion: request.pluginVersion, mode, data, error: null };
}

/** 表示 handler 被 executor 的 timeout/cancel 中断。 @author lvdaxianer@yeah.net @date 2026-10-17 */
class AbortExecutionError extends Error {
  /** @param kind - 中断原因 @returns 内部 abort error @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(public readonly kind: 'timeout' | 'cancelled') { super(kind); }
}

/** 提供 Worker、Sidecar、container 相同的受限执行语义。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class ConstrainedExecutor implements PluginExecutor {
  private readonly options: NormalizedOptions;
  private readonly active = new Map<string, ActiveRequest>();
  private readonly credentialScopes = new Map<string, CredentialScope>();
  private readonly allowedCapabilities: ReadonlySet<string>;
  private closed = false;

  /** @param mode - 执行模式 @param options - 资源与清理配置 @returns 新 executor @author lvdaxianer@yeah.net @date 2026-10-17 */
  public constructor(public readonly mode: ExecutorMode, options: ExecutorOptions) {
    this.options = normalizeOptions(options);
    this.allowedCapabilities = new Set(this.options.allowedCapabilities);
  }

  /** @param request - 外部请求 @param handler - 插件 handler @returns 稳定执行响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public execute(request: ExecutorRequest, handler: ExecutorHandler): Promise<ExecutorResponse> {
    const prepared = prepareRequest(request, this.options.maxInputBytes);
    if (!prepared.ok) return Promise.resolve(failure(request, this.mode, prepared.error));
    if (typeof handler !== 'function') return Promise.resolve(failure(prepared.value, this.mode, executorError('executor.invalid_request', 'Executor 请求无效')));
    const stableRequest = prepared.value;
    const invalid = this.validateExecution(stableRequest);
    if (invalid) return Promise.resolve(failure(stableRequest, this.mode, invalid));
    if (this.closed) return Promise.resolve(failure(stableRequest, this.mode, executorError('executor.closed', 'Executor 已关闭')));
    if (this.active.has(stableRequest.requestId)) return Promise.resolve(failure(stableRequest, this.mode, executorError('executor.duplicate_request', 'Executor 请求重复')));
    const entry = { request: stableRequest, controller: new AbortController(), promise: undefined as unknown as Promise<ExecutorResponse> };
    this.active.set(stableRequest.requestId, entry);
    this.credentialScopes.set(stableRequest.requestId, Object.freeze({ tenantId: stableRequest.tenantId, pluginId: stableRequest.pluginId, pluginVersion: stableRequest.pluginVersion }));
    entry.promise = this.run(entry, handler);
    return entry.promise;
  }

  /** @param requestId - 活动请求标识 @returns 是否找到并取消 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public cancel(requestId: string): boolean {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    this.abort(entry, 'cancelled');
    return true;
  }

  /** @param tenantId - 租户标识 @param pluginId - 插件标识 @returns 清理报告 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public async cleanupPlugin(tenantId: string, pluginId: string): Promise<CleanupReport> {
    const entries = [...this.active.values()].filter(({ request }) => request.tenantId === tenantId && request.pluginId === pluginId);
    entries.forEach((entry) => this.abort(entry, 'cancelled'));
    await Promise.all(entries.map(({ promise }) => promise));
    const removedSubscriptionIds = this.removeSubscriptions(tenantId, pluginId);
    for (const [requestId, scope] of this.credentialScopes) if (scope.tenantId === tenantId && scope.pluginId === pluginId) this.credentialScopes.delete(requestId);
    return { cancelledRequestIds: entries.map(({ request }) => request.requestId).sort(), removedSubscriptionIds };
  }

  /** @returns 当前活动请求数 @author lvdaxianer@yeah.net @date 2026-10-17 */
  public activeRequestCount(): number { return this.active.size; }

  /** @returns 全部活动请求完成后的 Promise @author lvdaxianer@yeah.net @date 2026-10-17 */
  public async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.active.values()];
    entries.forEach((entry) => this.abort(entry, 'cancelled'));
    await Promise.all(entries.map(({ promise }) => promise));
    this.credentialScopes.clear();
  }

  /** @param request - 已冻结请求 @returns 稳定校验错误或 null @author lvdaxianer@yeah.net @date 2026-10-17 */
  private validateExecution(request: ExecutorRequest): ExecutorError | null {
    const invalid = validateRequest(request);
    if (invalid) return invalid;
    if (request.pluginVersion !== this.options.version) return executorError('executor.version_mismatch', 'Plugin 版本未固定');
    if (request.capabilities.some((capability) => !this.allowedCapabilities.has(capability))) return executorError('executor.capability_denied', 'Plugin 能力未获允许');
    if (jsonBytes(request.input) > this.options.maxInputBytes) return executorError('executor.resource_limit', 'Plugin 输入超过资源上限');
    return null;
  }

  /** @param request - 已冻结请求 @returns 凭据校验错误或 null @author lvdaxianer@yeah.net @date 2026-10-17 */
  private resolveCredentials(request: ExecutorRequest): ExecutorError | null {
    if (request.credentialRefs.length === 0) return null;
    if (!this.options.resolveCredential) return executorError('executor.credential_unavailable', 'Plugin 凭据不可用');
    const scope = Object.freeze({ tenantId: request.tenantId, pluginId: request.pluginId, pluginVersion: request.pluginVersion });
    try {
      for (const ref of request.credentialRefs) if (this.options.resolveCredential(scope, ref) === undefined) return executorError('executor.credential_unavailable', 'Plugin 凭据不可用');
      return null;
    } catch {
      return executorError('executor.credential_unavailable', 'Plugin 凭据不可用');
    }
  }

  /** @param entry - 活动请求 entry @param handler - 插件 handler @returns 稳定执行响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private async run(entry: ActiveRequest, handler: ExecutorHandler): Promise<ExecutorResponse> {
    const { request } = entry;
    const credentialError = this.resolveCredentials(request);
    if (credentialError) return this.finish(entry, failure(request, this.mode, credentialError));
    let timer: NodeJS.Timeout | undefined;
    const aborted = new Promise<never>((_resolve, reject) => { entry.abortReject = () => reject(new AbortExecutionError(entry.abortKind ?? 'cancelled')); });
    try {
      timer = setTimeout(() => this.abort(entry, 'timeout'), Math.min(request.timeoutMs, this.options.maxTimeoutMs));
      const handlerResult = await Promise.race([handler(request.input, { pluginId: request.pluginId, runId: request.requestId, correlationId: request.traceId }, entry.controller.signal), aborted]);
      if (!isHandlerResult(handlerResult)) return this.finish(entry, failure(request, this.mode, executorError('executor.invalid_result', 'Plugin 结果无效')));
      if (jsonBytes(handlerResult.output) > this.options.maxOutputBytes) return this.finish(entry, failure(request, this.mode, executorError('executor.resource_limit', 'Plugin 输出超过资源上限')));
      const stableResult = snapshotHandlerResult(handlerResult);
      if (!stableResult) return this.finish(entry, failure(request, this.mode, executorError('executor.invalid_result', 'Plugin 结果无效')));
      return this.finish(entry, success(request, this.mode, stableResult));
    } catch (error) {
      if (error instanceof AbortExecutionError) return this.finish(entry, failure(request, this.mode, executorError(`executor.${error.kind}`, error.kind === 'timeout' ? 'Plugin 执行超时' : 'Plugin 执行已取消', error.kind === 'timeout')));
      return this.finish(entry, failure(request, this.mode, executorError('executor.handler_failed', 'Plugin 执行失败')));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** @param entry - 活动请求 entry @param kind - 中断原因 @returns 无返回值 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private abort(entry: ActiveRequest, kind: 'timeout' | 'cancelled'): void {
    if (entry.abortKind) return;
    entry.abortKind = kind;
    entry.controller.abort();
    entry.abortReject?.();
  }

  /** @param entry - 活动请求 entry @param response - 稳定响应 @returns 原响应 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private finish(entry: ActiveRequest, response: ExecutorResponse): ExecutorResponse {
    if (this.active.get(entry.request.requestId) === entry) this.active.delete(entry.request.requestId);
    this.credentialScopes.delete(entry.request.requestId);
    return response;
  }

  /** @param tenantId - 租户标识 @param pluginId - 插件标识 @returns 已移除订阅 ID @author lvdaxianer@yeah.net @date 2026-10-17 */
  private removeSubscriptions(tenantId: string, pluginId: string): string[] {
    const registry = this.options.subscriptionRegistry;
    const owner = this.options.subscriptionOwner;
    if (!registry || !owner || !this.options.subscriptionIds) return [];
    let subscriptionIds: readonly string[];
    try { subscriptionIds = this.options.subscriptionIds(tenantId, pluginId); } catch { return []; }
    try {
      if (!Array.isArray(subscriptionIds) || subscriptionIds.some((id) => !isStableString(id))) return [];
    } catch { return []; }
    const candidates: Array<{ id: string; subscription: HookSubscription }> = [];
    try {
      for (const subscriptionId of [...new Set(subscriptionIds)].sort()) {
        const subscription = registry.get(subscriptionId);
        if (!subscription) continue;
        if (owner(subscription, tenantId, pluginId)) candidates.push({ id: subscriptionId, subscription });
      }
    } catch { return []; }
    try {
      for (const candidate of candidates) if (!registry.unregister(candidate.id)) throw new Error('subscription.unregister_failed');
    } catch {
      for (const candidate of candidates) try { registry.register(candidate.subscription); } catch { /* 回滚失败仍不向外传播。 */ }
      return [];
    }
    return candidates.map(({ id }) => id);
  }
}

/** @param value - JSON-safe 值 @returns UTF-8 字节数 @author lvdaxianer@yeah.net @date 2026-10-17 */
function jsonBytes(value: JsonValue): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

/** @param value - 未知 handler result @returns 是否满足结果契约 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isHandlerResult(value: unknown): value is NonNullable<ExecutorResponse['data']> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    if (!Object.keys(value).every((key) => key === 'output' || key === 'status' || key === 'errorCode')) return false;
    const result = value as { output?: unknown; status?: unknown };
    const errorCode = (value as { errorCode?: unknown }).errorCode;
    return (result.status === 'succeeded' || result.status === 'failed') && isJsonValue(result.output) && (errorCode === undefined || isStableString(errorCode));
  } catch { return false; }
}

/** @param value - 未知 handler result @returns 冻结结果或 null @author lvdaxianer@yeah.net @date 2026-10-17 */
function snapshotHandlerResult(value: unknown): NonNullable<ExecutorResponse['data']> | null {
  if (!isHandlerResult(value)) return null;
  try { return freezeJson(structuredClone(value)) as NonNullable<ExecutorResponse['data']>; } catch { return null; }
}

/** @param request - 未知外部 request @returns 冻结 request 或稳定错误 @author lvdaxianer@yeah.net @date 2026-10-17 */
function prepareRequest(request: unknown, maxInputBytes: number): { ok: true; value: ExecutorRequest } | { ok: false; error: ExecutorError } {
  const invalid = validateRequest(request as ExecutorRequest);
  if (invalid) return { ok: false, error: invalid };
  try {
    const candidate = request as ExecutorRequest;
    if (jsonBytes(candidate.input) > maxInputBytes) return { ok: false, error: executorError('executor.resource_limit', 'Plugin 输入超过资源上限') };
    return { ok: true, value: Object.freeze({ ...candidate, capabilities: Object.freeze([...candidate.capabilities]), credentialRefs: Object.freeze([...candidate.credentialRefs]), input: freezeJson(structuredClone(candidate.input)) }) };
  } catch {
    return { ok: false, error: executorError('executor.invalid_request', 'Executor 请求无效') };
  }
}

/** @param value - 未知 request @param key - 字段名 @returns 安全字符串或空值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function safeString(value: unknown, key: string): string {
  try { const field = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined; return isStableString(field) ? field : ''; } catch { return ''; }
}

/** @param value - 未知标识 @returns 是否为有界稳定字符串 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isStableString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** @param value - JSON-safe 值 @returns 冻结后的同一值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function freezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) value.forEach((item) => freezeJson(item));
  else Object.values(value as Record<string, unknown>).forEach((item) => freezeJson(item));
  return Object.freeze(value);
}
