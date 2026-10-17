/**
 * 定义 ModelGateway 的 provider、验证器、错误、审计事件和调用结果。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import type { ModelAuditEntry, ModelAuditOutcome, ModelProfile, ModelProfileRegistry } from '../model-profile.js';
import type { DecisionBackend } from '../types.js';

/** 供 provider 读取但不能修改的递归快照类型。 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** provider 可观察到的单次结构化模型请求。 */
export type ModelProviderRequest = {
  /** 链路追踪标识。 */
  traceId: string;
  /** IAR run 标识。 */
  runId: string;
  /** 当前使用的不可变 profile。 */
  profile: DeepReadonly<ModelProfile>;
  /** 未修改的业务输入，provider 负责实际模型协议编码。 */
  input: DeepReadonly<JsonValue>;
  /** 当前 profile attempt，从 1 开始。 */
  attempt: number;
  /** timeout 时由 gateway 触发取消。 */
  signal: AbortSignal;
};

/** ModelGateway 注册的最小 provider 协议。 */
export interface ModelProvider {
  /**
   * 执行一次 provider 请求并返回未信任模型输出。
   * @param request - profile 绑定的结构化 provider 请求
   * @returns 未经 Schema 校验的模型输出
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  complete(request: ModelProviderRequest): Promise<unknown>;
}

/** provider 可显式声明、可参与 retryPolicy 匹配的失败分类。 */
export type ModelProviderFailureKind = 'provider_unavailable' | 'provider_failed';

/** 供 Mock/真实适配器使用的稳定 provider 错误。 @author lvdaxianer@yeah.net @date 2026-10-17 */
export class ModelProviderError extends Error {
  /** provider 失败分类。 */
  public readonly kind: ModelProviderFailureKind;

  /**
   * 创建不暴露原始异常正文的 provider 错误。
   * @param kind - 稳定 provider 失败分类
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(kind: ModelProviderFailureKind) {
    super(kind);
    this.name = 'ModelProviderError';
    this.kind = kind;
  }
}

/** ModelGateway 对外返回的稳定错误分类。 */
export type ModelGatewayErrorCode = 'model.invalid_request' | 'model.no_profile' | 'model.no_provider' | 'model.timeout' | 'model.provider_failed' | 'model.schema_invalid' | 'model.threshold_rejected' | 'model.fallback_failed';

/** 决策 backend 未配置时对外使用的稳定错误摘要。 */
export const MODEL_NO_PROFILE_MESSAGE = '决策模型 backend 未配置';

/** 不暴露 provider 原始 message 的模型错误。 */
export type ModelGatewayError = {
  /** 稳定机器可判断错误码。 */
  code: ModelGatewayErrorCode;
  /** 固定的人类可读错误摘要。 */
  message: string;
  /** 是否允许同一调用方安全重试。 */
  retryable: boolean;
  /** 脱敏且有限的诊断字段。 */
  details: Record<string, JsonValue>;
};

/** 每次 provider 尝试产生的结构化、脱敏模型事件。 */
export type ModelGatewayEvent = {
  /** 稳定事件名称。 */
  eventName: 'model.completed' | 'model.failed';
  /** 调用审计快照。 */
  audit: ModelAuditEntry;
  /** 失败或澄清时的稳定分类。 */
  errorCode?: ModelGatewayErrorCode;
};

/** adapter 对原始模型输出执行的结构化验证结果。 */
export type ModelOutputValidation<T> =
  | { ok: true; value: T; outcome?: ModelAuditOutcome; errorCode?: ModelGatewayErrorCode }
  | { ok: false; message: string };

/** gateway 调用上下文。 */
export type ModelInvocation = {
  /** 链路追踪标识。 */
  traceId: string;
  /** IAR run 标识。 */
  runId: string;
  /** 交给 provider 的 JSON 输入。 */
  input: JsonValue;
};

/**
 * ModelGateway 的可选决策后端选择参数。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export type ModelGatewayInvocationOptions = {
  /** 选择 role 使用的决策后端。 */
  decisionBackend?: DecisionBackend;
  /** 已由 resolver 解析出的 primary profile 标识。 */
  profileId?: string;
};

/** gateway 执行器的公开配置。 */
export type ModelGatewayOptions = {
  /** profile registry。 */
  registry: ModelProfileRegistry;
  /** provider 名称到实现的显式绑定。 */
  providers: Readonly<Record<string, ModelProvider>>;
};

/** 成功的模型调用结果。 */
export type ModelGatewaySuccess<T> = {
  ok: true;
  value: T;
  audit: readonly ModelAuditEntry[];
  events: readonly ModelGatewayEvent[];
};

/** 失败的模型调用结果。 */
export type ModelGatewayFailure = {
  ok: false;
  error: ModelGatewayError;
  audit: readonly ModelAuditEntry[];
  events: readonly ModelGatewayEvent[];
};

/** adapter 可消费的显式成功/失败联合结果。 */
export type ModelGatewayResult<T> = ModelGatewaySuccess<T> | ModelGatewayFailure;
