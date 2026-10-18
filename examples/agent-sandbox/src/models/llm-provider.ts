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

/** OpenAI 兼容 chat/completions 响应的最小读取形状。 */
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/** OpenAI 兼容 chat/completions 流式 chunk 的最小读取形状。 */
type ChatCompletionStreamChunk = {
  choices?: Array<{ delta?: { content?: unknown } }>;
};

/** 语义抽取角色的系统提示词。 */
const SEMANTIC_SYSTEM_PROMPT = `你是 IAR（Intent Action Runtime）的 Semantic Extractor。
把用户输入抽取为 iar.semantic-frame/v1 结构的 JSON 对象，只允许以下字段：
{ "schemaVersion": "iar.semantic-frame/v1", "subject": {...}, "intent": string, "action": string, "slots": {...}, "references": [...], "confidence": number }

intent 只允许四个取值之一：
- knowledge.query：用户想查询知识/资料/政策。槽位 slots.query = 用户想查的内容。
- ticket.create：用户想提交工单/报障/提单。槽位 slots.title（简短标题）、slots.description（详细描述）、slots.priority（low/medium/high）。
- human.transfer：用户想转人工/找客服/人工协助。槽位 slots.reason（转接原因）、slots.summary（问题摘要）。
- unknown：无法归入以上三类。

规则：
1. 缺槽位时只抽取已有的槽位，不要编造。
2. confidence 取 0 到 1。
3. references 解析输入中的指代，没有则为空数组。
4. 只输出一个 JSON 对象，不要输出 Markdown、解释文字或代码围栏。`;

/** 上下文压缩角色的系统提示词。 */
const COMPACT_SYSTEM_PROMPT = `你是 IAR（Intent Action Runtime）的 Context Compactor。
你的唯一任务是在不改变行为状态的前提下压缩旧对话和旧事件，生成可校验的结构化摘要。
硬性规则：
1. 只使用输入中明确出现的事实，不得猜测补充。
2. 必须原样保留 state.subject、state.intent、state.action、state.route、state.slots、state.workflow、state.pending、state.confirmation。
3. 不得重新选择 Function 或 Plugin，不得改变 confirmation 或 workflow 状态。
4. 只输出一个 JSON 对象，不要输出 Markdown、解释文字或代码围栏。
5. 输出必须符合 iar.compaction-result/v1：{ "schemaVersion": "iar.compaction-result/v1", "summary": string, "state": {...}, "references": [...], "preservedFacts": [...], "warnings": [...] }。
preservedFacts 必须包含：subject、action、functionId、pluginId、slots、workflow.currentStep、pending、confirmation、intent、idempotencyKey。`;

/** 回复生成角色的系统提示词。 */
const RESPONSE_SYSTEM_PROMPT = `你是 IAR（Intent Action Runtime）的 Response Generator。
根据给定的执行结果生成面向用户的自然语言回复。
只输出一个符合 iar.response/v1 的 JSON 对象：{ "schemaVersion": "iar.response/v1", "text": string }。
不要输出 Markdown、解释文字或代码围栏。text 使用简洁友好的中文。`;

/** 流式回复生成角色的系统提示词：直接输出正文，避免 JSON 包装逐字流出到界面。 */
const RESPONSE_STREAM_SYSTEM_PROMPT = `你是 IAR（Intent Action Runtime）的 Response Generator。
根据给定的执行结果生成面向用户的自然语言回复。
直接输出回复正文本身：不要输出 JSON、schemaVersion 包装、Markdown 或解释性文字。
使用简洁友好的中文，可以分点。`;

/** 压缩提示词中的 compression_policy 片段。 */
const COMPACTION_POLICY = `{
  "schemaVersion": "iar.compaction-result/v1",
  "maxSummaryChars": 1200,
  "requiredPaths": [
    "state.subject",
    "state.intent",
    "state.action",
    "state.route.functionId",
    "state.route.pluginId",
    "state.slots",
    "state.workflow.currentStep",
    "state.pending",
    "state.confirmation"
  ],
  "preserveEventReferences": true
}`;

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
    const raw = await this.callChatCompletion(connection, prompt.system, prompt.user, request.signal);
    return parseJsonContent(raw);
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
    return await this.streamChatCompletion(connection, prompt.system, prompt.user, request.signal, onDelta, false);
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
      return { system: SEMANTIC_SYSTEM_PROMPT, user: `用户输入：${readString(input, 'text') ?? JSON.stringify(request.input)}` };
    }
    if (request.profile.role === 'context.compact') {
      return { system: COMPACT_SYSTEM_PROMPT, user: buildCompactionUserPrompt(input) };
    }
    return { system: RESPONSE_SYSTEM_PROMPT, user: buildResponseUserPrompt(input) };
  }

  /**
   * 调用 OpenAI 兼容 chat/completions 接口。
   *
   * @param model - 本次调用使用的模型标识
   * @param system - 系统提示词
   * @param user - 用户内容
   * @param signal - gateway 注入的取消信号
   * @returns choices[0].message.content 原文
   * @throws ModelProviderError 当 HTTP 状态非 2xx 或网络失败
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

  /**
   * 调用 OpenAI 兼容 chat/completions 接口。
   *
   * @param connection - 已解析且不写入 profile 的连接信息
   * @param system - 系统提示词
   * @param user - 用户内容
   * @param signal - gateway 注入的取消信号
   * @returns choices[0].message.content 原文
   * @throws ModelProviderError 当 HTTP 状态非 2xx 或网络失败
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private async callChatCompletion(connection: { apiKey: string | undefined; baseUrl: string | undefined; model: string }, system: string, user: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
        body: JSON.stringify({
          model: connection.model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
    } catch {
      // 网络层异常统一归类为 provider 暂不可用，让 gateway 走 retry/fallback。
      throw new ModelProviderError('provider_unavailable');
    }
    if (!response.ok) throw new ModelProviderError('provider_failed');
    let payload: ChatCompletionResponse;
    try {
      payload = await response.json() as ChatCompletionResponse;
    } catch {
      throw new ModelProviderError('provider_failed');
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) throw new ModelProviderError('provider_failed');
    return content;
  }

  /**
   * 调用 OpenAI 兼容 chat/completions 流式接口并逐行解析 SSE。
   *
   * 只识别 `data: ` 前缀的有效负载行，`[DONE]` 为结束标记；
   * 注释行、非法 JSON 行和空 delta 直接跳过，保证对端心跳或
   * 个别坏帧不会中断整段回复。accumulate 的全文最终交回 completeStreamed 解析。
   *
   * @param connection - 已解析且不写入 profile 的连接信息
   * @param system - 系统提示词
   * @param user - 用户内容
   * @param signal - gateway 注入的取消信号
   * @param onDelta - 每个 content 增量的回调
   * @returns accumulate 后的全文
   * @throws ModelProviderError 当 HTTP 状态非 2xx、网络失败、读取中断或全文为空
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private async streamChatCompletion(connection: { apiKey: string | undefined; baseUrl: string | undefined; model: string }, system: string, user: string, signal: AbortSignal, onDelta: (delta: string) => void, jsonFormat = true): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
        body: JSON.stringify({
          model: connection.model,
          temperature: 0.2,
          stream: true,
          ...(jsonFormat ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
    } catch {
      // 网络层异常（含 abort）统一归类为 provider 暂不可用。
      throw new ModelProviderError('provider_unavailable');
    }
    if (!response.ok || response.body === null) throw new ModelProviderError('provider_failed');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let accumulated = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.trim();
          if (!text.startsWith('data:')) continue;
          const data = text.slice('data:'.length).trim();
          if (data === '[DONE]') continue;
          let chunk: ChatCompletionStreamChunk;
          try {
            chunk = JSON.parse(data) as ChatCompletionStreamChunk;
          } catch {
            // 个别坏帧（如服务端心跳注释被误切）不中断整段回复。
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            onDelta(delta);
          }
        }
      }
    } catch {
      // 读取中断或解码失败按 provider 暂不可用归类，保留已收到增量的兜底由调用方决定。
      throw new ModelProviderError('provider_unavailable');
    }
    if (accumulated.length === 0) throw new ModelProviderError('provider_failed');
    return accumulated;
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
 * 按参考模板拼装压缩用户提示词。
 *
 * @param input - 调用方注入的 behaviorContext、eventsToCompact 和 recentMessages
 * @returns 压缩用户内容
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function buildCompactionUserPrompt(input: Record<string, unknown>): string {
  const contextJson = JSON.stringify(input.behaviorContext ?? {}, null, 2);
  const eventsJson = JSON.stringify(input.eventsToCompact ?? [], null, 2);
  const messagesJson = JSON.stringify(input.recentMessages ?? [], null, 2);
  return [
    '请压缩以下 IAR 上下文。',
    '',
    '<behavior_context>',
    contextJson,
    '</behavior_context>',
    '',
    '<events_to_compact>',
    eventsJson,
    '</events_to_compact>',
    '',
    '<recent_messages>',
    messagesJson,
    '</recent_messages>',
    '',
    '<compression_policy>',
    COMPACTION_POLICY,
    '</compression_policy>'
  ].join('\n');
}

/**
 * 拼装回复生成的用户内容。
 *
 * 输入携带 availableFunctions 时视为路由未命中的兜底回复请求：
 * 基于最近对话自然回答"你是谁/你能做什么/我刚才让你做什么"类问题，
 * 或自然解释可执行能力；否则按执行结果生成常规回复。
 *
 * @param input - 调用方注入的用户消息和执行结果或兜底上下文
 * @returns 回复生成用户内容
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function buildResponseUserPrompt(input: Record<string, unknown>): string {
  if (Array.isArray(input.availableFunctions)) {
    return [
      '本轮路由未命中任何可执行功能，需要生成一条兜底回复。',
      `用户消息：${readString(input, 'userMessage') ?? ''}`,
      `最近对话：${JSON.stringify(input.recentMessages ?? [])}`,
      `可用功能：${input.availableFunctions.map((item) => String(item)).join('、')}`,
      `未命中原因码：${readString(input, 'reasonCode') ?? 'unknown'}`,
      '要求：用户问"你是谁/你是做什么的"时，自然自我介绍为 IAR Agent Sandbox（可交互的 IAR 插件沙盒，演示意图识别、两阶段路由和插件执行链路）；用户提到"刚才/之前"让你做的事时，根据最近对话回答；其他情况自然解释你能做什么并各给一个简短示例。语气简洁友好，不要提及路由失败或原因码。',
      '请生成面向用户的最终回复 JSON。'
    ].join('\n');
  }
  return [
    `用户消息：${readString(input, 'userMessage') ?? ''}`,
    `执行功能：${readString(input, 'functionId') ?? 'unknown'} / 插件：${readString(input, 'pluginId') ?? 'unknown'}`,
    `执行状态：${readString(input, 'actionStatus') ?? 'unknown'}`,
    `执行输出：${JSON.stringify(input.actionOutput ?? null)}`,
    '请生成面向用户的最终回复 JSON。'
  ].join('\n');
}

/**
 * 解析模型返回的 JSON 文本。
 *
 * @param content - choices[0].message.content 原文
 * @returns 解析后的 JSON 值
 * @throws ModelProviderError 当文本不是合法 JSON
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // 结构化输出解析失败只能转为稳定 provider 错误，不能传播原始正文。
    throw new ModelProviderError('provider_failed');
  }
}

/**
 * 读取冻结输入中的字符串字段。
 *
 * @param input - provider 请求输入
 * @param key - 字段名
 * @returns 非空字符串或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function readString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
