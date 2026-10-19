/**
 * 提供基于真实 LLM API 的 IAR ModelProvider 实现（brain 模式）。
 *
 * 该 provider 通过内置 fetch 调用 OpenAI 兼容的 chat/completions 接口，
 * 按 request.profile.role 分支构造结构化输出提示词：
 * semantic.extract 抽取 iar.semantic-frame/v1，
 * context.compact 生成 iar.compaction-result/v1，
 * response.generate 生成 iar.response/v1。
 * 解析失败或缺 key 时抛出 ModelProviderError，交由 ModelGateway 走 fallback。
 * response.generate 额外支持 SSE 流式输出（completeStreamed），
 * 内部逐行解析 data: 增量并 accumulate 全文；流式回复直接输出正文（非 JSON 契约），
 * 避免 JSON 包装逐字流出到界面。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import {
  INTENT_DECISION_PROMPT_VERSION,
  INTENT_DECISION_SYSTEM_PROMPT,
  ModelProviderError,
  type ModelProfileEnvironment,
  type ModelProvider,
  type ModelProviderRequest
} from '@iar/decision';
import { callModel } from './model-transport.js';
import { runWithModelLogContext } from '../safe-log.js';
import { callModelStream } from './model-stream-transport.js';
import { SEMANTIC_SYSTEM_PROMPT, COMPACT_SYSTEM_PROMPT, RESPONSE_SYSTEM_PROMPT, RESPONSE_STREAM_SYSTEM_PROMPT,
  buildCompactionUserPrompt, buildResponseUserPrompt, buildSemanticUserPrompt, readString } from './model-input-transport.js';

/** brain provider 的可注入配置。 */
export type BrainProviderOptions = {
  /** LLM API Key，未配置时任何调用都失败。 */
  apiKey?: string;
  /** OpenAI 兼容接口基础地址。 */
  baseUrl?: string;
  /** 默认模型标识，profile environment 未覆盖时使用。 */
  modelId?: string;
};

/** Intent Model provider 的可注入配置。 */
export type IntentProviderOptions = BrainProviderOptions;

/** OpenAI-compatible provider 的连接配置。 */
export type OpenAICompatibleProviderOptions = {
  /** 显式 API key，环境变量映射优先。 */
  apiKey?: string;
  /** 显式基础地址，环境变量映射优先。 */
  baseUrl?: string;
  /** 显式模型标识，环境变量映射优先。 */
  modelId?: string;
  /** 未声明 profile 映射时使用的 endpoint 环境变量。 */
  endpointEnv: string;
  /** 未声明 profile 映射时使用的 API key 环境变量。 */
  apiKeyEnv: string;
  /** 兼容旧配置使用的 API key 环境变量。 */
  fallbackApiKeyEnv?: string;
  /** 未声明 profile 映射时使用的模型环境变量。 */
  modelIdEnv: string;
  /** 未声明 endpoint 环境变量时的兼容默认地址。 */
  defaultBaseUrl?: string;
};

/**
 * 通过真实 LLM API 执行结构化模型调用的 provider。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class OpenAICompatibleModelProvider implements ModelProvider {
  /** provider 级显式连接配置和默认环境变量。 */
  protected readonly options: OpenAICompatibleProviderOptions;

  /**
   * 创建 OpenAI-compatible provider，缺 key 时保持未配置状态。
   *
   * @param options - API Key 与基础地址；模型标识统一由 models.brain.json 各 profile 的 modelId 决定
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: OpenAICompatibleProviderOptions) {
    this.options = options;
  }

  /**
   * 按 role 构造提示词并解析结构化 JSON 输出。
   *
   * @param request - gateway 冻结的 provider 请求
   * @returns 未经 Schema 校验的模型输出对象
   * @throws ModelProviderError 当未配置 key、HTTP 失败或 JSON 解析失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async complete(request: ModelProviderRequest): Promise<unknown> {
    const connection = this.resolveConnection(request.profile);
    if (!connection.apiKey || !connection.baseUrl) throw new ModelProviderError('provider_unavailable');
    const prompt = this.buildPrompt(request);
    return await runWithModelLogContext(request.traceId, () => callModel({ connection, ...prompt, signal: request.signal }));
  }

  /**
   * 执行流式模型调用，逐段回调 delta content 并返回解析后的 JSON 输出。
   *
   * 只允许 response.generate 角色流式：semantic.extract/context.compact 的
   * 结构化 JSON 契约不能拆成半截增量，避免破坏 Schema 校验边界。
   *
   * @param request - gateway 冻结的 provider 请求
   * @param onDelta - 每个 content 增量的回调
   * @returns 与 complete() 相同的解析后模型输出对象
   * @throws ModelProviderError 当角色不允许流式、未配置 key、HTTP 失败或 JSON 解析失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async completeStreamed(request: ModelProviderRequest, onDelta: (delta: string) => void): Promise<unknown> {
    if (request.profile.role !== 'response.generate') throw new ModelProviderError('provider_failed');
    const connection = this.resolveConnection(request.profile);
    if (!connection.apiKey || !connection.baseUrl) throw new ModelProviderError('provider_unavailable');
    // 流式场景直接输出正文（非 JSON 契约），accumulate 全文原样返回，由调用方兜底解析。
    const prompt = this.buildStreamPrompt(request);
    return await runWithModelLogContext(request.traceId, () => callModelStream({ connection, ...prompt, signal: request.signal }, onDelta));
  }

  /**
   * 流式回复生成的提示词：response.generate 直接输出正文，其余角色与非流式一致。
   *
   * @param request - gateway 冻结的 provider 请求
   * @returns 系统提示词和用户内容
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected buildStreamPrompt(request: ModelProviderRequest): { system: string; user: string } {
    if (request.profile.role === 'response.generate') {
      return { system: RESPONSE_STREAM_SYSTEM_PROMPT, user: buildResponseUserPrompt(asRecord(request.input)) };
    }
    return this.buildPrompt(request);
  }

  /**
   * 按 role 选择系统提示词并拼装用户内容。
   *
   * @param request - gateway 冻结的 provider 请求
   * @returns 系统提示词和用户内容
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected buildPrompt(request: ModelProviderRequest): { system: string; user: string } {
    const input = asRecord(request.input);
    if (request.profile.role === 'semantic.extract') {
      return { system: SEMANTIC_SYSTEM_PROMPT, user: buildSemanticUserPrompt(input) };
    }
    if (request.profile.role === 'context.compact') {
      return { system: COMPACT_SYSTEM_PROMPT, user: buildCompactionUserPrompt(input) };
    }
    return { system: RESPONSE_SYSTEM_PROMPT, user: buildResponseUserPrompt(input) };
  }

  /**
   * 根据模型配置解析连接信息。
   *
   * @param profile - 模型配置
   * @returns 当前调用使用的连接信息
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private resolveConnection(profile: ModelProviderRequest['profile']): { apiKey: string | undefined; baseUrl: string | undefined; model: string } {
    const environment = profile.environment as ModelProfileEnvironment | undefined;
    const mappedEndpoint = readEnvironment(environment?.endpoint);
    const mappedApiKey = readEnvironment(environment?.apiKey);
    const mappedModelId = readEnvironment(environment?.modelId);
    const apiKey = mappedApiKey ?? nonEmpty(this.options.apiKey) ?? readEnvironment(this.options.apiKeyEnv) ?? readEnvironment(this.options.fallbackApiKeyEnv);
    const baseUrl = mappedEndpoint ?? nonEmpty(this.options.baseUrl) ?? readEnvironment(this.options.endpointEnv) ?? this.options.defaultBaseUrl;
    const model = mappedModelId ?? nonEmpty(this.options.modelId) ?? readEnvironment(this.options.modelIdEnv) ?? profile.modelId;
    return { apiKey, baseUrl: baseUrl?.replace(/\/+$/, ''), model };
  }

}

/** 普通交互模型 provider，保留既有 brain 角色的提示词协议。 */
export class BrainModelProvider extends OpenAICompatibleModelProvider {
  /**
   * 创建普通交互模型 provider。
   *
   * @param options - API key、endpoint 和模型默认值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: BrainProviderOptions = {}) {
    super({
      ...options,
      endpointEnv: 'IAR_LLM_BASE_URL',
      apiKeyEnv: 'IAR_LLM_API_KEY',
      fallbackApiKeyEnv: 'IAR_MODEL_API_KEY',
      modelIdEnv: 'IAR_LLM_MODEL_ID',
      defaultBaseUrl: 'https://api.moonshot.cn/v1'
    });
  }
}

/**
 * Intent Model provider，使用独立连接配置和固定版本化决策 Prompt。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class IntentModelProvider extends OpenAICompatibleModelProvider {
  /**
   * 创建 Intent Model provider。
   *
   * @param options - API key、endpoint 和模型默认值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: IntentProviderOptions = {}) {
    super({
      ...options,
      endpointEnv: 'IAR_INTENT_MODEL_ENDPOINT',
      apiKeyEnv: 'IAR_INTENT_MODEL_API_KEY',
      modelIdEnv: 'IAR_INTENT_MODEL_ID'
    });
  }

  /**
   * 固定使用 iar.intent-decision-prompt/v1 和公共 DecisionResult 输出约束。
   *
   * @param request - gateway 冻结的 Intent Model 请求
   * @returns 固定系统 Prompt 与 JSON 用户内容
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  protected override buildPrompt(request: ModelProviderRequest): { system: string; user: string } {
    return {
      system: `${INTENT_DECISION_SYSTEM_PROMPT}\nPrompt version: ${INTENT_DECISION_PROMPT_VERSION}`,
      user: JSON.stringify({ promptVersion: INTENT_DECISION_PROMPT_VERSION, input: request.input })
    };
  }
}

/** 读取 profile 声明的环境变量名对应的非空值。 */
function readEnvironment(name: string | undefined): string | undefined {
  return name ? nonEmpty(process.env[name]) : undefined;
}

/** 把空白配置视为未配置，避免空值覆盖有效默认值。 */
function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}




/**
 * 把未知输入收窄为普通对象。
 *
 * @param value - 未知输入
 * @returns 普通对象或空对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
