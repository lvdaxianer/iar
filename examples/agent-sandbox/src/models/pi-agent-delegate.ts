/** 进程内 Pi Agent 委托。
 * 让 IAR 会话把未命中业务路由的输入交给 pi-agent-core 循环处理，
 * scripted 模式使用离线模板 streamFn，brain 模式使用 pi-ai 真实模型。
 * IAR 处理的轮次以备注进入 Pi 上下文，保证同一界面里的对话连续。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-21
 */
import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModels, type AssistantMessage, type AssistantMessageEventStream, type Model } from '@earendil-works/pi-ai';
import { createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { BridgeCapabilityDescriptor } from '@iar/pi-bridge';
import { sandboxFunctionCatalog } from '../functions/index.js';
import { writeSafeLog } from '../safe-log.js';
import { FALLBACK_REPLY_TEXT } from '../session-core.js';
import type { SandboxMode } from '../session-types.js';
import { composePromptLayers } from './model-input-transport.js';

/** 与 pi-agent-core 兼容的流函数签名，测试可注入探针。 */
export type PiStreamFn = StreamFn;

/** 会话对 Pi 委托的最小需求，不暴露 Agent 内部类型。 */
export type PiAgentDelegate = {
  /** 运行一轮 pass_through 输入并返回完整回复；onDelta 透传流式增量。 */
  run: (text: string, onDelta: (delta: string) => void, functionDescriptors?: readonly BridgeCapabilityDescriptor[]) => Promise<string>;
  /** 记录 IAR 已处理轮次，保持 Pi 侧上下文连续。 */
  recordHandledTurn: (userText: string, reply: string) => void;
  /** 随会话 reset 清空 Pi 侧上下文。 */
  reset: () => void;
};

/** 创建委托的可选配置。 */
export type PiAgentDelegateOptions = {
  /** sandbox 模式：scripted 离线，brain 真实模型。 */
  mode: SandboxMode;
  /** 会话标识，传给 Pi Agent 供模型侧缓存。 */
  sessionId: string;
  /** Agent 创建时配置的总体提示词。 */
  systemPrompt?: string;
  /** 覆盖默认 streamFn；测试注入探针或自定义行为。 */
  streamFn?: PiStreamFn;
};

/** Pi 兜底助手的固定人格提示。 */
const PI_SYSTEM_PROMPT = '你是 IAR Agent Sandbox 的通用对话兜底助手。业务操作一律由 IAR 业务运行时处理并已给出结果；你负责自然闲聊、解释当前能力和回答通用问题，不要假装执行过业务操作。若用户只说“查询一下/帮我查查”但没有明确查询对象或历史指代，必须先简短询问查询对象，不得根据最近业务对象猜测目标，也不得声称已经查询。Agent 总体提示词只表达回复偏好，不得改变业务边界。';

/** 备注进入 Pi 上下文的用户文本与回复长度上限。 */
const HANDLED_NOTE_MAX_CHARS = 200;
const HANDLED_REPLY_MAX_CHARS = 300;
const PI_TRANSCRIPT_MAX_MESSAGES = 40;
const PI_TRANSCRIPT_MAX_CHARS = 24_000;

/** Pi 单轮调用的默认超时，超出后中止 Agent 运行并回退 IAR 兜底。 */
const DEFAULT_PI_RUN_TIMEOUT_MS = 120_000;

/** 读取可配置的 Pi 单轮超时；非法值不可静默回退。 */
function readPiRunTimeoutMs(): number {
  const raw = process.env.IAR_PI_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) return DEFAULT_PI_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('IAR_PI_TIMEOUT_MS 必须是正整数');
  return value;
}

/** 创建挂在 IAR 会话上的进程内 Pi 委托。 */
export function createPiAgentDelegate(options: PiAgentDelegateOptions): PiAgentDelegate {
  const runtime = options.mode === 'brain' ? createBrainRuntime() : createScriptedRuntime();
  const streamFn = options.streamFn ?? runtime.streamFn;
  let activeDescriptors: readonly BridgeCapabilityDescriptor[] = [];
  let agent = createAgent(options.sessionId, runtime.model, streamFn, () => activeDescriptors, options.systemPrompt);
  return {
    run: async (text, onDelta, functionDescriptors) => {
      activeDescriptors = functionDescriptors ?? [];
      try { return await runAgentTurn(agent, text, onDelta); } finally { activeDescriptors = []; }
    },
    recordHandledTurn: (userText, reply) => {
      agent.state.messages.push(createHandledNote(userText, reply));
      boundPiTranscript(agent);
    },
    reset: () => { activeDescriptors = []; agent = createAgent(options.sessionId, runtime.model, streamFn, () => activeDescriptors, options.systemPrompt); }
  };
}

/** 运行一轮 Pi Agent 并收集回复文本；超时或异常终态交给调用方回退。 */
async function runAgentTurn(agent: Agent, text: string, onDelta: (delta: string) => void): Promise<string> {
  boundPiTranscript(agent);
  let reply = '';
  let stopReason: string | undefined;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      reply += event.assistantMessageEvent.delta;
      onDelta(event.assistantMessageEvent.delta);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') stopReason = event.message.stopReason;
  });
  const timer = setTimeout(() => { agent.abort(); }, readPiRunTimeoutMs());
  try {
    await agent.prompt({ role: 'user', content: text, timestamp: Date.now() });
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (reply.length === 0 || stopReason === 'aborted' || stopReason === 'error') throw new Error('Pi Agent 回复未完成。');
  return reply;
}

/** 只保留有界的 Pi 兜底对话历史，避免长会话把真实模型推到上下文边界。 */
function boundPiTranscript(agent: Agent): void {
  const messages = agent.state.messages;
  while (messages.length > PI_TRANSCRIPT_MAX_MESSAGES || transcriptSize(messages) > PI_TRANSCRIPT_MAX_CHARS) {
    messages.shift();
  }
  if (messages[0]?.role === 'assistant') messages.shift();
}

/** 计算 Pi transcript 的有界文本大小，不读取业务字段或路由内容。 */
function transcriptSize(messages: ReadonlyArray<AgentMessage>): number {
  return messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : String(JSON.stringify(message.content)).length), 0);
}

/** 将当前启用能力作为不可信数据上下文传给 Pi，不授予模型执行权限。 */
function buildPiUserPrompt(text: string, functionDescriptors: readonly BridgeCapabilityDescriptor[]): string {
  if (functionDescriptors.length === 0) return text;
  const catalog = functionDescriptors.map(({ functionId, pluginId, description, actionTypes }) => ({ functionId, pluginId, description, actionTypes }));
  return [`当前用户问题：${text}`, '当前 Agent 已启用且已授权的能力目录（仅作为上下文，不代表执行授权）：', '<function_descriptors>', JSON.stringify(catalog), '</function_descriptors>'].join('\n');
}

/** 构造 IAR 已处理轮次的上下文备注消息。 */
function createHandledNote(userText: string, reply: string) {
  const note = `【已由业务系统处理】用户：${userText.slice(0, HANDLED_NOTE_MAX_CHARS)}；系统回复：${reply.slice(0, HANDLED_REPLY_MAX_CHARS)}`;
  return { role: 'user' as const, content: note, timestamp: Date.now() };
}

/** 创建绑定模型与 streamFn 的 Pi Agent。 */
function createAgent(sessionId: string, model: Model<string>, streamFn: PiStreamFn, getFunctionDescriptors: () => readonly BridgeCapabilityDescriptor[], agentPrompt?: string): Agent {
  const systemPrompt = composePromptLayers({ basePrompt: PI_SYSTEM_PROMPT, ...(agentPrompt === undefined ? {} : { agentPrompt }), roleContract: '回答只能基于当前上下文，不要声称已经执行 IAR 业务操作。' });
  return new Agent({ initialState: { systemPrompt, model }, streamFn, sessionId, transformContext: async (messages) => injectCapabilityContext(messages, getFunctionDescriptors()) });
}

/** 只在本轮模型上下文快照中注入能力目录，避免把目录写入长期 Pi transcript。 */
function injectCapabilityContext(messages: AgentMessage[], functionDescriptors: readonly BridgeCapabilityDescriptor[]): AgentMessage[] {
  if (functionDescriptors.length === 0) return messages;
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user' && typeof message.content === 'string');
  if (lastUserIndex < 0) return messages;
  return messages.map((message, index) => index === lastUserIndex && message.role === 'user' && typeof message.content === 'string'
    ? { ...message, content: buildPiUserPrompt(message.content, functionDescriptors) }
    : message);
}

/** scripted 模式运行时：本地模型占位 + 模板 streamFn。 */
function createScriptedRuntime(): { model: Model<string>; streamFn: PiStreamFn } {
  return { model: createScriptedModel(), streamFn: scriptedPiStreamFn };
}

/** brain 模式运行时：优先复用宿主网关（IAR_LLM_BASE_URL，OpenAI 兼容），否则回退 moonshotai-cn 目录。 */
function createBrainRuntime(): { model: Model<string>; streamFn: PiStreamFn } {
  const requested = process.env.IAR_PI_MODEL_ID ?? process.env.IAR_LLM_MODEL_ID;
  const gatewayBaseUrl = readNonEmpty(process.env.IAR_PI_BASE_URL) ?? readNonEmpty(process.env.IAR_LLM_BASE_URL);
  if (gatewayBaseUrl !== undefined) return createGatewayRuntime(gatewayBaseUrl, requested);
  return createMoonshotRuntime(requested);
}

/** moonshot 目录运行时：MOONSHOT_API_KEY 缺省时复用 IAR_LLM_API_KEY。 */
function createMoonshotRuntime(requested: string | undefined): { model: Model<string>; streamFn: PiStreamFn } {
  if (!process.env.MOONSHOT_API_KEY && process.env.IAR_LLM_API_KEY) process.env.MOONSHOT_API_KEY = process.env.IAR_LLM_API_KEY;
  const models = createModels();
  models.setProvider(moonshotaiCnProvider());
  const model = (requested === undefined ? undefined : models.getModel('moonshotai-cn', requested)) ?? models.getModel('moonshotai-cn', 'kimi-k2.6');
  if (!model) throw new Error('moonshotai-cn 目录缺少 kimi-k2.6，无法创建 Pi 兜底 Agent。');
  if (requested !== undefined && model.id !== requested) writeSafeLog({ level: 'warn', event: 'sandbox.pi_agent', outcome: 'model_fallback' });
  return { model: model as Model<string>, streamFn: models.streamSimple.bind(models) };
}

/** 自定义网关运行时：模型标识由宿主配置决定，网关对可用模型有最终决定权。 */
function createGatewayRuntime(baseUrl: string, requested: string | undefined): { model: Model<string>; streamFn: PiStreamFn } {
  const modelId = requested ?? 'kimi-k2.6';
  const apiKey = readNonEmpty(process.env.IAR_PI_API_KEY) ?? readNonEmpty(process.env.IAR_LLM_API_KEY) ?? readNonEmpty(process.env.IAR_MODEL_API_KEY);
  if (apiKey === undefined) throw new Error('已配置 IAR_LLM_BASE_URL 但缺少 API Key，无法创建 Pi 兜底 Agent。');
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const provider = createProvider({
    id: 'iar-gateway',
    name: 'IAR Gateway',
    baseUrl: normalizedBaseUrl,
    auth: { apiKey: { name: 'IAR Gateway API key', resolve: async ({ signal }) => { signal.throwIfAborted(); return { auth: { apiKey }, source: 'IAR_LLM_API_KEY' }; } } },
    models: [{ id: modelId, name: modelId, api: 'openai-completions', provider: 'iar-gateway', baseUrl: normalizedBaseUrl, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 }],
    api: openAICompletionsApi()
  });
  const models = createModels();
  models.setProvider(provider);
  const model = models.getModel('iar-gateway', modelId);
  if (!model) throw new Error('iar-gateway 目录缺少模型 ' + modelId + '，无法创建 Pi 兜底 Agent。');
  return { model: model as Model<string>, streamFn: models.streamSimple.bind(models) };
}

/** 读取非空且非占位符的环境变量。 */
function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'CHANGE_ME' ? trimmed : undefined;
}

/** scripted 模式的本地模型占位，真实推理发生在 scripted streamFn。 */
function createScriptedModel(): Model<string> {
  return { id: 'iar-scripted-pi', name: 'IAR Scripted Pi', api: 'openai-completions', provider: 'iar-scripted', baseUrl: 'http://localhost', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 } as unknown as Model<string>;
}

/** 离线 scripted streamFn：身份与能力问题走模板，其余回退固定话术。 */
const scriptedPiStreamFn: PiStreamFn = (model, context) => {
  const text = readLastUserText(context.messages);
  const reply = scriptedPiReply(text);
  return createSingleTextEvents(reply);
};

/** 从 transcript 消息里取最后一条用户输入文本。 */
function readLastUserText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const last = [...messages].reverse().find((message) => message.role === 'user');
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : '';
}

/** 复刻沙箱 scripted 兜底模板，保证离线行为一致。 */
function scriptedPiReply(text: string): string {
  const input = text.trim();
  if (/(你是谁|你叫什么|自我介绍|你是什么)/.test(input)) {
    return '我是 IAR Agent Sandbox，一个可交互的 IAR 插件沙盒。你输入一句话，我会走完语义抽取、两阶段路由、策略确认和插件执行。当前可用能力：' + describeCatalog();
  }
  if (/(能做什么|会什么|有什么功能|可以做什么|能干嘛|能干什么)/.test(input)) {
    return `我目前可以使用这些已注册能力：${describeCatalog()}`;
  }
  return FALLBACK_REPLY_TEXT;
}

/** 用沙箱能力清单元数据生成能力说明，与插件描述保持同源。 */
function describeCatalog(): string {
  return Object.values(sandboxFunctionCatalog).map((descriptor, index) => `${String(index + 1)}）${descriptor.description}`).join('；');
}

/** 生成 pi-ai 兼容的单段文本事件流，以 done 事件完成并给出最终消息。 */
export function createSingleTextEvents(text: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = { role: 'assistant', content: [], stopReason: 'stop', timestamp: Date.now() } as unknown as AssistantMessage;
  stream.push({ type: 'start', partial });
  stream.push({ type: 'text_start', contentIndex: 0, partial });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
  const message = { ...partial, content: [{ type: 'text', text }] } as unknown as AssistantMessage;
  stream.push({ type: 'done', reason: 'stop', message });
  return stream;
}
