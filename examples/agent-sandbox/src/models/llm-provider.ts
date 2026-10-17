/**
 * 提供基于真实 LLM API 的 IAR ModelProvider 实现（brain 模式）。
 *
 * 该 provider 通过内置 fetch 调用 OpenAI 兼容的 chat/completions 接口，
 * 按 request.profile.role 分支构造结构化输出提示词：
 * semantic.extract 抽取 iar.semantic-frame/v1，
 * context.compact 生成 iar.compaction-result/v1，
 * response.generate 生成 iar.response/v1。
 * 解析失败或缺 key 时抛出 ModelProviderError，交由 ModelGateway 走 fallback。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import { ModelProviderError, type ModelProvider, type ModelProviderRequest } from '@iar/decision';

/** brain provider 的可注入配置。 */
export type BrainProviderOptions = {
  /** LLM API Key，未配置时任何调用都失败。 */
  apiKey?: string;
  /** OpenAI 兼容接口基础地址。 */
  baseUrl?: string;
};

/** OpenAI 兼容 chat/completions 响应的最小读取形状。 */
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
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
export class BrainModelProvider implements ModelProvider {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  /**
   * 创建 brain provider，缺 key 时保持未配置状态。
   *
   * @param options - API Key 与基础地址；模型标识统一由 models.brain.json 各 profile 的 modelId 决定
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public constructor(options: BrainProviderOptions = {}) {
    // 密钥只从环境变量读取：优先 IAR_LLM_API_KEY，兼容 .env.example 中的 IAR_MODEL_API_KEY。
    this.apiKey = options.apiKey ?? process.env.IAR_LLM_API_KEY ?? process.env.IAR_MODEL_API_KEY;
    this.baseUrl = (options.baseUrl ?? process.env.IAR_LLM_BASE_URL ?? 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
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
    if (!this.apiKey) throw new ModelProviderError('provider_unavailable');
    // 模型统一取当前 profile 的 modelId，模型选择只在 models.brain.json 一处配置。
    const model = request.profile.modelId;
    const prompt = this.buildPrompt(request);
    const raw = await this.callChatCompletion(model, prompt.system, prompt.user, request.signal);
    return parseJsonContent(raw);
  }

  /**
   * 按 role 选择系统提示词并拼装用户内容。
   *
   * @param request - gateway 冻结的 provider 请求
   * @returns 系统提示词和用户内容
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private buildPrompt(request: ModelProviderRequest): { system: string; user: string } {
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
  private async callChatCompletion(model: string, system: string, user: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model,
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
    const payload = await response.json() as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) throw new ModelProviderError('provider_failed');
    return content;
  }
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
 * @param input - 调用方注入的用户消息和执行结果
 * @returns 回复生成用户内容
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function buildResponseUserPrompt(input: Record<string, unknown>): string {
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
