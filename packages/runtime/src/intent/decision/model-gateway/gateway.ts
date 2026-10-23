/**
 * 提供统一的 profile 选择、超时、有限重试、fallback、脱敏审计和稳定错误边界。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { redactModelRequest, type ModelAuditEntry, type ModelAuditOutcome, type ModelProfile, type ModelRole } from '../model-profile.js';
import type { JsonValue } from '@iar/contracts';
import { createDecisionAuditMetadata, resolveCrossBackendProfile, resolveFallbackProfile, resolvePrimaryProfileForInvocation } from './decision-backend.js';
import { MODEL_NO_PROFILE_MESSAGE, ModelProviderError, type ModelGatewayError, type ModelGatewayEvent, type ModelGatewayFailure, type ModelGatewayInvocationOptions, type ModelGatewayOptions, type ModelGatewayResult, type ModelInvocation, type ModelOutputValidation, type ModelProvider, type ModelProviderRequest } from './types.js';

/** 仅供 gateway 内部区分 timeout race；不把原始 timer 错误暴露给调用方。 @author lvdaxianer@yeah.net @date 2026-10-17 */
class GatewayTimeoutError extends Error {}

/** 当前 attempt 的稳定失败摘要。 */
type AttemptFailure = { code: ModelGatewayError['code']; message: string };

/** 当前 attempt 的成功或失败审计联合结果。 */
type AttemptResult<T> =
  | { ok: true; value: T; audit: ModelAuditEntry; event: ModelGatewayEvent }
  | { ok: false; failure: AttemptFailure; audit: ModelAuditEntry; event: ModelGatewayEvent };

/** 单个 profile 执行参数，避免通过参数顺序传递安全边界。 */
type ProfileRunOptions<T> = { role: ModelRole; invocation: ModelInvocation; profile: ModelProfile; validate: (raw: unknown) => ModelOutputValidation<T>; useFallback: boolean; onAudit?: ModelGatewayOptions['onAudit'] };

/** 单个 provider attempt 参数。 */
type AttemptOptions<T> = ProfileRunOptions<T> & { provider: ModelProvider; attempt: number };

/** 输出处理参数。 */
type OutputOptions<T> = AttemptOptions<T> & { raw: unknown };

/** audit entry 构造参数。 */
type AuditOptions = { role: ModelRole; invocation: ModelInvocation; profile: ModelProfile; fallbackUsed: boolean; attempt: number; outcome: ModelAuditOutcome; errorCode?: ModelGatewayEvent['errorCode']; reason?: string };

/** provider 缺失失败参数。 */
type FailedAttemptOptions = AuditOptions & { code: ModelGatewayEvent['errorCode']; audit: ModelAuditEntry[]; events: ModelGatewayEvent[]; onAudit?: ModelGatewayOptions['onAudit'] };
/** retry loop 的已绑定 provider 参数。 */
type RetryLoopOptions<T> = { profile: ModelProfile; audit: ModelAuditEntry[]; events: ModelGatewayEvent[]; onAudit?: ModelGatewayOptions['onAudit']; runAttempt: (attempt: number) => Promise<AttemptResult<T>> };

/** 统一封装五类模型角色的 provider 调用。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class ModelGateway {
  // registry 是 profile/model 版本的唯一解析来源。
  // providers 是显式注入的 provider 白名单。
  // auditRecorder 负责统一脱敏和版本快照。
  private readonly registry: ModelGatewayOptions['registry'];
  private readonly providers: ModelGatewayOptions['providers'];
  private readonly onAudit: ModelGatewayOptions['onAudit'];

  // 所有 role adapter 都通过 invoke 进入同一超时/重试/fallback 门禁。
  // provider 不直接暴露原始异常和原始请求日志。
  // 结果联合类型要求调用方显式处理 ok=false。
  // 成功值只能来自 role validator，而不是 provider 原始返回。
  // 失败 details 永远是有限 JSON，不保留 stack 或 Error。

  /**
   * 创建带显式 provider 注册表的 ModelGateway。
   * @param options - profile registry 和 provider 绑定
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: ModelGatewayOptions) {
    this.registry = options.registry;
    this.providers = options.providers;
    this.onAudit = options.onAudit;
  }

  /**
   * 按 role 执行一次经过验证的模型调用。
   * @param role - 模型角色
   * @param invocation - trace/run 和 JSON 输入
   * @param validate - role adapter 的结构化输出校验器
   * @returns 结构化成功值或稳定失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async invoke<T>(role: ModelRole, invocation: ModelInvocation, validate: (raw: unknown) => ModelOutputValidation<T>, options?: ModelGatewayInvocationOptions): Promise<ModelGatewayResult<T>> {
    const inputError = validateInvocation(invocation);
    // 非 JSON 输入或空链路标识在 provider 之前 fail-closed。
    if (inputError) return { ok: false, error: inputError, audit: [], events: [] };
    const invocationSnapshot = createInvocationSnapshot(invocation);
    // 所有 retry/fallback/audit 共享同一个冻结输入快照。
    if (!invocationSnapshot) return invalidInputResult();
    const primaryProfile = resolvePrimaryProfileForInvocation(this.registry, role, options);
    // 未知 role 不能伪造 fallback 或 audit 版本。
    if (!primaryProfile) return options ? noProfileResult() : invalidRoleResult();
    const primary = await this.runProfile({ role, invocation: invocationSnapshot, profile: primaryProfile, validate, useFallback: false, onAudit: this.onAudit });
    // primary 成功或产生合法澄清结果时不触发 fallback。
    if (primary.ok) return primary;
    return this.finishWithFallback({ role, invocation: invocationSnapshot, validate, profile: primaryProfile, primary, crossBackendFallback: options?.crossBackendFallback === true, onAudit: this.onAudit, ...(options?.crossBackendInput !== undefined ? { crossBackendInput: options.crossBackendInput } : {}) });
  }

  /**
   * 合并 primary/fallback attempt 的结果和审计事件。
   * @param options - primary 结果及 fallback 解析参数
   * @returns 合并后的模型调用结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async finishWithFallback<T>(options: { role: ModelRole; invocation: ModelInvocation; validate: (raw: unknown) => ModelOutputValidation<T>; profile: ModelProfile; primary: ModelGatewayFailure; crossBackendFallback: boolean; onAudit?: ModelGatewayOptions['onAudit']; crossBackendInput?: JsonValue }): Promise<ModelGatewayResult<T>> {
    // 没有显式 fallback 时保留 primary 的稳定失败和审计证据。
    if (!options.profile.fallbackProfileId && (!options.crossBackendFallback || !canCrossBackendFallback(options.primary.error.code))) return options.primary;
    // 只有 provider/transport failure 才能通过显式配置跨 backend；schema 和业务边界错误不扩大调用范围。
    const fallback = await this.runFallback({ role: options.role, invocation: options.invocation, validate: options.validate, profile: options.profile, primary: options.primary, crossBackendFallback: options.crossBackendFallback && canCrossBackendFallback(options.primary.error.code), onAudit: options.onAudit, ...(options.crossBackendInput !== undefined ? { crossBackendInput: options.crossBackendInput } : {}) });
    // 没有可用的同 backend 或跨 backend primary 时保留原始稳定失败。
    if (!fallback) return options.primary;
    // fallback 成功仍保留 primary attempt，便于审计降级原因。
    if (fallback.ok) return { ...fallback, audit: [...options.primary.audit, ...fallback.audit], events: [...options.primary.events, ...fallback.events] };
    // 两条路径均失败时返回明确 fallback_failed，不伪装 provider 成功。
    return { ok: false, error: { code: 'model.fallback_failed', message: '模型主 provider 和 fallback 均失败', retryable: false, details: { primaryCode: options.primary.error.code, fallbackCode: fallback.error.code } }, audit: [...options.primary.audit, ...fallback.audit], events: [...options.primary.events, ...fallback.events] };
  }

  /**
   * 在单个 profile 上执行有限 attempt，并把每个 attempt 变成审计事件。
   * @param options - profile、调用上下文、输出验证器和 fallback 标识
   * @returns 当前 profile 的成功或失败结果
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async runProfile<T>(options: ProfileRunOptions<T>): Promise<ModelGatewayResult<T>> {
    const { role, invocation, profile, validate, useFallback } = options;
    // 单个 profile 的 attempts 独立计数，fallback 不复用 primary attempt。
    const provider = getProvider(this.providers, profile.provider);
    const audit: ModelAuditEntry[] = [];
    const events: ModelGatewayEvent[] = [];
    // provider 缺失是配置故障，不执行动态发现或网络调用。
    if (!provider) return this.failedAttempt({ role, invocation, profile, fallbackUsed: useFallback, attempt: 1, outcome: 'provider_failed', errorCode: 'model.no_provider', reason: '模型 provider 未注册', code: 'model.no_provider', audit, events, onAudit: options.onAudit });
    // provider 只能读取冻结 profile 快照，retry loop 使用原始受信任配置。
    const providerProfile = deepFreeze(structuredClone(profile));
    return runRetryLoop({ profile, audit, events, onAudit: options.onAudit, runAttempt: (attempt) => this.runAttempt({ ...options, profile: providerProfile, provider, attempt }) });
  }

  /**
   * 执行一个 provider attempt，并将结果收敛为单条审计事件。
   * @param options - provider、profile、调用上下文和 attempt 参数
   * @returns 单 attempt 成功值或稳定失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async runAttempt<T>(options: AttemptOptions<T>): Promise<AttemptResult<T>> {
    const { role, invocation, profile, provider, validate, useFallback, attempt } = options;
    try {
      // timeout controller 只作用于当前 attempt，不能污染其他 attempt。
      const raw = await this.withTimeout(provider, { traceId: invocation.traceId, runId: invocation.runId, profile, input: invocation.input, attempt, signal: new AbortController().signal }, profile.timeoutMs);
      // 原始 provider 输出必须继续经过 role-specific validator。
      return this.handleOutput({ ...options, raw });
    } catch (error) {
      // timeout/provider 异常只保留稳定分类，原始异常正文不进入审计。
      const failure = classifyFailure(error);
      const outcome = failure.code === 'model.timeout' ? 'timeout' : 'provider_failed';
      const audit = this.auditEntry({ role, invocation, profile, fallbackUsed: useFallback, attempt, outcome, errorCode: failure.code, reason: failure.message });
      return { ok: false, failure, audit, event: { eventName: 'model.failed', audit, errorCode: failure.code } };
    }
  }

  /**
   * 将已返回的原始输出验证、克隆并转换为审计事件。
   * @param options - provider attempt 和 raw output
   * @returns 隔离后的成功值或稳定 Schema 失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private handleOutput<T>(options: OutputOptions<T>): AttemptResult<T> {
    const { role, invocation, profile, validate, useFallback, attempt, raw } = options;
    // validator 只决定结构和业务边界，不允许原始输出直接传播。
    const output = validate(raw);
    if (!output.ok) {
      // Schema 失败只能转为 rejected attempt，不能把原始输出继续传播。
      const audit = this.auditEntry({ role, invocation, profile, fallbackUsed: useFallback, attempt, outcome: 'rejected', errorCode: 'model.schema_invalid', reason: output.message });
      return { ok: false, failure: { code: 'model.schema_invalid', message: '模型结构化输出无效' }, audit, event: { eventName: 'model.failed', audit, errorCode: 'model.schema_invalid' } };
    }
    // 合法结构化输出才可以成为 adapter 的成功值或澄清值。
    const outcome = output.outcome ?? (useFallback ? 'fallback' : 'success');
    const audit = this.auditEntry({ role, invocation, profile, fallbackUsed: useFallback, attempt, outcome, ...(output.errorCode ? { errorCode: output.errorCode } : {}), ...(output.errorCode === 'model.threshold_rejected' ? { reason: '模型结果低于阈值' } : {}) });
    return { ok: true, value: structuredClone(output.value), audit, event: { eventName: output.errorCode ? 'model.failed' : 'model.completed', audit, ...(output.errorCode ? { errorCode: output.errorCode } : {}) } };
  }

  /** 使用 fallback profile 执行第二条 provider 路径。 @param options - fallback 执行参数 @returns fallback 结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private async runFallback<T>(options: { role: ModelRole; invocation: ModelInvocation; validate: (raw: unknown) => ModelOutputValidation<T>; profile: ModelProfile; primary: ModelGatewayFailure; crossBackendFallback: boolean; onAudit?: ModelGatewayOptions['onAudit']; crossBackendInput?: JsonValue }): Promise<ModelGatewayResult<T> | undefined> {
    const { role, invocation, validate, profile, primary, crossBackendFallback, onAudit, crossBackendInput } = options;
    try {
      const sameBackendFallback = resolveFallbackProfile(this.registry, profile);
      if (sameBackendFallback) {
        const sameResult = await this.runProfile({ role, invocation, profile: sameBackendFallback, validate, useFallback: true, onAudit });
        // 同 backend fallback 成功后立即结束，不能因为显式策略再额外调用另一 backend。
        if (sameResult.ok || !crossBackendFallback || !canCrossBackendFallback(sameResult.error.code)) return sameResult;
        const crossProfile = resolveCrossBackendProfile(this.registry, profile);
        if (!crossProfile) return sameResult;
        const crossInvocation = createFallbackInvocation(invocation, crossBackendInput);
        if (!crossInvocation) return invalidInputResult();
        const crossResult = await this.runProfile({ role, invocation: crossInvocation, profile: crossProfile, validate, useFallback: true, onAudit });
        return mergeFallbackAttempts(sameResult, crossResult);
      }
      const crossProfile = crossBackendFallback ? resolveCrossBackendProfile(this.registry, profile) : undefined;
      if (!crossProfile) return undefined;
      const crossInvocation = createFallbackInvocation(invocation, crossBackendInput);
      if (!crossInvocation) return invalidInputResult();
      return await this.runProfile({ role, invocation: crossInvocation, profile: crossProfile, validate, useFallback: true, onAudit });
    } catch {
      // registry fallback 配置损坏也要保留 primary code 并稳定失败。
      return { ok: false, error: { code: 'model.fallback_failed', message: '模型 fallback 配置无效', retryable: false, details: { primaryCode: primary.error.code } }, audit: [], events: [] };
    }
  }

  /**
   * 执行 provider 并用 AbortSignal 和 timer 形成 timeout 门禁。
   * @param provider - 当前 profile provider
   * @param request - provider 请求
   * @param timeoutMs - profile timeout
   * @returns provider 原始输出
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async withTimeout(provider: ModelProvider, request: ModelProviderRequest, timeoutMs: number): Promise<unknown> {
    // controller 只服务当前 attempt，避免不同 attempt 共享取消状态。
    const controller = new AbortController();
    const providerRequest = { ...request, signal: controller.signal };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 取消原因使用固定安全值，供传输层识别超时；对外错误仍由 gateway 统一映射。
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(new DOMException('Model call timed out', 'TimeoutError')); reject(new GatewayTimeoutError()); }, timeoutMs); });
    try {
      // 异步 provider 才能被 timeout race 可靠监管，禁止同步返回绕过门禁。
      const result = provider.complete(providerRequest);
      if (!isPromiseLike(result)) throw new ModelProviderError('provider_failed');
      return await Promise.race([result, timeout]);
    } finally {
      // 成功或失败都清理 timer，避免调用结束后残留异步任务。
      if (timer) clearTimeout(timer);
    }
  }

  /** 记录一次不含决策原始 input 的 audit entry。 @param options - audit 构造参数 @returns 脱敏审计快照 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private auditEntry(options: AuditOptions): ModelAuditEntry {
    const metadata = options.role === 'function.call' || options.role === 'function.select' || options.role === 'plugin.select'
      ? createDecisionAuditMetadata(options.profile, options.invocation.input, options.reason)
      : redactModelRequest({ provider: options.profile.provider, request: options.invocation.input });
    return { traceId: options.invocation.traceId, runId: options.invocation.runId, role: options.role, profileId: options.profile.profileId, profileVersion: options.profile.profileVersion, modelId: options.profile.modelId, modelVersion: options.profile.modelVersion, attempt: options.attempt, outcome: options.outcome, fallbackUsed: options.fallbackUsed, metadata };
  }

  /** 记录 provider 不存在的失败 attempt。 @param options - 失败 attempt 参数 @returns 失败结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
  private failedAttempt<T>(options: FailedAttemptOptions): ModelGatewayResult<T> {
    // 缺 provider 也写入失败证据，便于配置审计和问题定位。
    const entry = this.auditEntry(options);
    options.audit.push(entry);
    options.events.push({ eventName: 'model.failed', audit: entry, ...(options.code ? { errorCode: options.code } : {}) });
    notifyAudit(options.onAudit, entry, options.events.at(-1)!);
    return { ok: false, error: { code: options.code ?? 'model.no_provider', message: '模型 provider 未注册', retryable: false, details: {} }, audit: options.audit, events: options.events };
  }
}

/** 只有 provider/transport 类失败允许显式跨 backend，避免把 schema 或业务拒绝扩散为第二次模型调用。 @param code - primary 稳定错误码 @returns 是否允许跨 backend @author lvdaxianer@yeah.net @date 2026-10-17 */
function canCrossBackendFallback(code: ModelGatewayError['code']): boolean {
  return code === 'model.provider_failed' || code === 'model.timeout' || code === 'model.no_provider';
}

/** 合并同 backend 与跨 backend 的 fallback attempt，并保持最终错误稳定。 @param first - 同 backend 结果 @param second - 跨 backend 结果 @returns 合并后的 fallback 结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function mergeFallbackAttempts<T>(first: ModelGatewayResult<T>, second: ModelGatewayResult<T>): ModelGatewayResult<T> {
  if (second.ok) return { ...second, audit: [...first.audit, ...second.audit], events: [...first.events, ...second.events] };
  return { ok: false, error: { code: 'model.fallback_failed', message: '模型主 provider 和 fallback 均失败', retryable: false, details: { primaryCode: first.ok ? 'model.provider_failed' : first.error.code, fallbackCode: second.error.code } }, audit: [...first.audit, ...second.audit], events: [...first.events, ...second.events] };
}

/** 为跨 backend 输入重新建立冻结快照，防止 provider 修改 Prompt 后污染审计或后续 attempt。 @param invocation - primary 冻结调用 @param input - 目标 backend 输入 @returns 冻结 fallback 调用或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function createFallbackInvocation(invocation: ModelInvocation, input?: JsonValue): ModelInvocation | undefined {
  // 没有跨 backend 输入时复用 primary snapshot，同 backend fallback 不重复复制。
  if (input === undefined) return invocation;
  return createInvocationSnapshot({ ...invocation, input });
}

/** 在单个 profile 内执行有界 retry loop。 @param options - retry 状态和 attempt 回调 @returns 当前 profile 的稳定结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
async function runRetryLoop<T>(options: RetryLoopOptions<T>): Promise<ModelGatewayResult<T>> {
  let lastFailure: AttemptFailure = { code: 'model.provider_failed', message: '模型 provider 调用失败' };
  for (let attempt = 1; attempt <= options.profile.retryPolicy.maxAttempts; attempt += 1) {
    const result = await options.runAttempt(attempt);
    options.audit.push(result.audit);
    options.events.push(result.event);
    notifyAudit(options.onAudit, result.audit, result.event);
    // 任一 attempt 成功后立即停止 retry，避免重复调用 provider。
    if (result.ok) return { ok: true, value: result.value, audit: options.audit, events: options.events };
    lastFailure = result.failure;
    // retry 只由 profile policy 放行，并受 maxAttempts 硬上限约束。
    if (!shouldRetry(options.profile.retryPolicy.retryOn, lastFailure.code) || attempt === options.profile.retryPolicy.maxAttempts) break;
    await waitBackoff(options.profile.retryPolicy.backoffMs);
  }
  return { ok: false, error: { code: lastFailure.code, message: lastFailure.message, retryable: lastFailure.code === 'model.timeout' || lastFailure.code === 'model.provider_failed', details: {} }, audit: options.audit, events: options.events };
}

/** 观测回调只用于诊断，任何写入故障都不能改变模型调用结果。 */
function notifyAudit(observer: ModelGatewayOptions['onAudit'], audit: ModelAuditEntry, event: ModelGatewayEvent): void {
  try {
    observer?.(audit, event);
  } catch {
    // 观测边界故障必须被隔离，不能让模型主链失败。
  }
}

/** 把 provider 异常转换为不泄漏正文的稳定错误。 @param error - provider 或 timeout 异常 @returns 稳定错误摘要 @author lvdaxianer@yeah.net @date 2026-10-17 */
function classifyFailure(error: unknown): { code: ModelGatewayError['code']; message: string } {
  // 只有 gateway 自己产生的 timeout 和显式 provider kind 能影响分类。
  if (error instanceof GatewayTimeoutError) return { code: 'model.timeout', message: '模型调用超时' };
  if (error instanceof ModelProviderError && error.kind === 'provider_unavailable') return { code: 'model.provider_failed', message: '模型 provider 暂不可用' };
  return { code: 'model.provider_failed', message: '模型 provider 调用失败' };
}

/** 判断 provider 失败分类是否被 profile retryPolicy 允许。 @param retryOn - profile 允许的分类 @param code - 当前稳定错误码 @returns 是否允许 retry @author lvdaxianer@yeah.net @date 2026-10-17 */
function shouldRetry(retryOn: readonly string[], code: ModelGatewayError['code']): boolean {
  // schema/threshold/fallback 错误不扩大 retry 范围。
  // provider_unavailable 仍通过稳定 provider_failed 对外归类。
  // timeout 仅在 profile 显式声明 timeout 时重试。
  return code === 'model.timeout' ? retryOn.includes('timeout') : code === 'model.provider_failed' && retryOn.some((item) => item === 'provider_failed' || item === 'provider_unavailable');
}

/** 校验 gateway 输入并拒绝非 JSON 或空链路标识。 @param invocation - 未信任调用输入 @returns 稳定错误或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function validateInvocation(invocation: unknown): ModelGatewayError | undefined {
  // 入口先做对象和链路字段校验，再读取 input 进行 JSON boundary 检查。
  // 该校验在 profile 查询前执行，避免无效输入触发 provider 行为。
  if (!isRecord(invocation) || !isNonEmptyString(invocation.traceId) || !isNonEmptyString(invocation.runId)) return { code: 'model.invalid_request', message: '模型调用输入无效', retryable: false, details: {} };
  try {
    redactModelRequest(invocation.input);
  } catch {
    return { code: 'model.invalid_request', message: '模型调用输入无效', retryable: false, details: {} };
  }
  return undefined;
}

/** 创建一次性、递归冻结的 invocation 快照。 @param invocation - 已通过入口校验的调用 @returns 冻结快照或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function createInvocationSnapshot(invocation: ModelInvocation): ModelInvocation | undefined {
  try {
    return deepFreeze(structuredClone(invocation));
  } catch {
    // Proxy 或不可克隆对象不能进入 retry/fallback 生命周期。
    return undefined;
  }
}

/** 创建不含 audit 的稳定 invalid_request。 @returns 输入失败结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function invalidInputResult<T>(): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.invalid_request', message: '模型调用输入无效', retryable: false, details: {} }, audit: [], events: [] };
}

/** 判断输入是否为普通对象。 @param value - 未知值 @returns 是否为普通对象 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isRecord(value: unknown): value is Record<string, unknown> {
  // 数组、null 和类实例不会在此处被当作可读取请求。
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断字符串是否非空。 @param value - 未知值 @returns 是否为非空字符串 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isNonEmptyString(value: unknown): value is string {
  // 空 trace/run 不允许创建无关联审计记录。
  // 类型校验不做 trim，稳定 ID 的具体格式由上层 contract 决定。
  // 这里只拒绝空字符串，避免悄悄改写调用方标识。
  return typeof value === 'string' && value.length > 0;
}

/** 判断 provider 是否返回 Promise/thenable。 @param value - provider 返回值 @returns 是否为异步结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return isRecord(value) && typeof value.then === 'function';
}

/** 返回 own-property 且 complete 为函数的 provider。 @param providers - 未信任 provider 注册表 @param name - provider 名称 @returns 合法 provider 或 undefined @author lvdaxianer@yeah.net @date 2026-10-17 */
function getProvider(providers: unknown, name: string): ModelProvider | undefined {
  // 先检查 registry 自身和 own-property，再读取 complete 函数。
  try {
    if (!isRecord(providers) || !Object.prototype.hasOwnProperty.call(providers, name)) return undefined;
    const candidate = providers[name];
    return isRecord(candidate) && typeof candidate.complete === 'function' ? candidate as unknown as ModelProvider : undefined;
  } catch {
    // getter、Proxy 和其他异常注册表访问统一视为 provider 未注册。
    return undefined;
  }
}

/** 创建不带敏感 details 的 role 配置错误。 @returns 稳定 invalid_request 结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function invalidRoleResult<T>(): ModelGatewayResult<T> {
  // role 配置错误不创建 audit，避免没有合法 profile 时伪造版本。
  return { ok: false, error: { code: 'model.invalid_request', message: '模型 role 配置无效', retryable: false, details: {} }, audit: [], events: [] };
}

/** 创建不暴露配置细节的 backend 缺失结果。 @returns 稳定 model.no_profile 结果 @author lvdaxianer@yeah.net @date 2026-10-17 */
function noProfileResult<T>(): ModelGatewayResult<T> {
  return { ok: false, error: { code: 'model.no_profile', message: MODEL_NO_PROFILE_MESSAGE, retryable: false, details: {} }, audit: [], events: [] };
}

/** 等待 profile 声明的有限退避时间。 @param backoffMs - 退避毫秒数 @returns 等待完成 Promise @author lvdaxianer@yeah.net @date 2026-10-17 */
function waitBackoff(backoffMs: number): Promise<void> {
  // backoff 已由 ModelProfileRegistry 限制在有限毫秒范围。
  return new Promise((resolve) => setTimeout(resolve, backoffMs));
}

/** 递归冻结 provider 读取的 profile/input 快照。 @param value - 待冻结值 @returns 同一递归冻结值 @author lvdaxianer@yeah.net @date 2026-10-17 */
function deepFreeze<T>(value: T): T {
  // provider 只能读取快照，不能篡改后续 retry/fallback 控制面。
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value);
}
