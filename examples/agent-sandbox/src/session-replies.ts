/** 模型回复和最近消息历史。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { randomUUID } from 'node:crypto';
import type { ActionDefinition, ActionResult, BehaviorContext, JsonValue, PendingInput, VerifiedFactRecord } from '@iar/contracts';
import { ResponseGeneratorAdapter, type ClarificationMetadata, type ModelGateway, type ModelProfileRegistry } from '@iar/runtime';
import type { SessionMessage } from '@iar/storage';
import type { PluginDescriptor } from '@iar/plugins';
import { OpenAICompatibleModelProvider, type BrainModelProvider } from './models/llm-provider.js';
import type { ScriptedModelProvider } from './models/scripted-provider.js';
import { SandboxSessionCompaction, type CompactionContext } from './session-compaction.js';
import type { CompactResult, ResolvedFactReference, SandboxMode } from './session-types.js';
import { FALLBACK_REPLY_TEXT } from './session-core.js';
import { streamModelReply } from './session-model-stream.js';

/** 模型回复所需的运行和输入上下文。
 * traceId 与 runId 继承当前轮次，不创建新的会话身份。
 * 所有回复路径共享同一个输入形状，避免普通和流式入口漂移。
 */
type ReplyContext = { traceId: string; runId: string; userText: string; behaviorContext: BehaviorContext; recentMessages: Array<{ role: string; text: string }>; functionDescriptors: PluginDescriptor[] };
type FallbackContext = ReplyContext & { reasonCode: string; resolvedReferences?: ResolvedFactReference[]; referenceCandidates?: VerifiedFactRecord[] };
type ActionReplyContext = ReplyContext & { action: ActionDefinition; actionResult: ActionResult };

/** 回复及压缩只访问宿主状态，重置后所有访问器指向当前会话。 */
export type SessionRepliesContext = CompactionContext & {
  mode: SandboxMode;
  brainProvider: BrainModelProvider | ScriptedModelProvider;
  registry: ModelProfileRegistry;
  gateway: ModelGateway;
  /** 当前会话允许提供给模型的原文消息数量上限。 */
  recentMessageLimit: number;
  /** 当前会话允许提供给模型的单条原文字符上限。 */
  recentMessageMaxChars: number;
  /** 当前启用 Plugin 的动态能力描述。 */
  functionDescriptors: PluginDescriptor[];
  updateClarification: (pending: PendingInput) => Promise<void>;
  /** 将完整消息发布给会话持久化 Hook；未配置 Provider 时为空操作。 */
  recordMessage?: (message: SessionMessage) => void;
};

type ScriptedReply = { text: string; clarification?: ClarificationMetadata };

/** 模型回复和最近消息历史。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export class SandboxSessionReplies {
  private readonly compaction: SandboxSessionCompaction;

  /** 组合压缩组件并保留实时状态访问器。
   * reset 会替换存储和投影，不能捕获旧对象的快照。
   * @param context - 宿主会话的模型依赖与实时状态
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public constructor(private readonly context: SessionRepliesContext) {
    this.compaction = new SandboxSessionCompaction(context);
  }

  /** 触发当前会话的上下文压缩。
   * @returns 压缩结果
   * @author lvdaxianer@yeah.net @date 2026-10-18
   */
  public compact(): Promise<CompactResult> { return this.compaction.compact(); }
  /**
   * 路由未命中时的兜底回复：brain 走 Response Generator，scripted 走模板。
   * 最近对话只传递有限窗口，不把整个事件历史传给回复模型。
   * 模型失败时返回固定话术，不暴露上游异常或模型原文。
   *
   * @param context - 链路、用户输入及路由未命中原因
   * @returns 兜底回复文本，生成失败时回退固定话术
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async fallbackReply(context: FallbackContext): Promise<string> {
    const { traceId, runId, userText, behaviorContext, recentMessages, functionDescriptors, reasonCode, resolvedReferences, referenceCandidates } = context;
    if (this.context.mode === 'brain') {
      const generated = await new ResponseGeneratorAdapter(this.context.gateway).generate({
        traceId,
        runId,
        input: {
          userMessage: userText,
          behaviorContext,
          recentMessages,
          availableFunctions: functionDescriptors,
          functionDescriptors,
          reasonCode,
          ...(resolvedReferences === undefined ? {} : { resolvedReferences }),
          ...(referenceCandidates === undefined ? {} : { referenceCandidates })
        }
      });
      // 只有生成失败才回退固定话术。
      if (generated.ok) {
        await this.persistClarification(behaviorContext, generated.value.clarification);
        return generated.value.text;
      }
      return FALLBACK_REPLY_TEXT;
    }
    const scripted = this.scriptedFallbackResponse(userText, behaviorContext, functionDescriptors, resolvedReferences, reasonCode, referenceCandidates);
    await this.persistClarification(behaviorContext, scripted?.clarification);
    return scripted?.text ?? FALLBACK_REPLY_TEXT;
  }

  /** 将模型通过契约返回的澄清元数据转换为可重放 pending 事件。 */
  private async persistClarification(context: BehaviorContext, clarification: ClarificationMetadata | undefined): Promise<void> {
    if (context.clarification?.mode === 'selection' && context.pending.kind === 'selection' && context.pending.status === 'required') return;
    if (clarification) {
      await this.context.updateClarification({ kind: clarification.kind, status: clarification.status, ...(clarification.options ? { options: structuredClone(clarification.options) } : {}) });
      return;
    }
    if (context.pending.status === 'required') await this.context.updateClarification({ kind: context.pending.kind, status: 'none' });
  }


  /**
   * 流式兜底回复：brain 模式逐段透传 delta，失败回退非流式兜底；scripted 模式一次性下发模板回复。
   *
   * @param context - 链路、用户输入及路由失败原因
   * @param onDelta - 回复增量回调
   * @returns 兜底回复全文
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async fallbackReplyStreamed(context: FallbackContext, onDelta: (delta: string) => void): Promise<string> {
    const { traceId, runId, userText, behaviorContext, recentMessages, functionDescriptors, reasonCode, resolvedReferences, referenceCandidates } = context;
    if (this.context.mode !== 'brain' || !(this.context.brainProvider instanceof OpenAICompatibleModelProvider)) {
      const reply = await this.fallbackReply(context);
      onDelta(reply);
      return reply;
    }
    const input: JsonValue = {
      userMessage: userText,
      behaviorContext,
      recentMessages,
      availableFunctions: functionDescriptors,
      functionDescriptors,
      reasonCode,
      ...(resolvedReferences === undefined ? {} : { resolvedReferences }),
      ...(referenceCandidates === undefined ? {} : { referenceCandidates })
    };
    const fallback = () => this.fallbackReply(context);
    return streamModelReply({ provider: this.context.brainProvider, profile: this.context.registry.forRole('response.generate'), traceId, runId, input, onDelta, onClarification: (clarification) => this.persistClarification(behaviorContext, clarification), onInvalid: fallback, onFailure: fallback });
  }


  /**
   * scripted 模式的轻量模板兜底：身份介绍、十项能力说明和基于最近对话的指令回忆。
   *
   * @param userText - 用户输入文本
   * @returns 模板回复文本，模板覆盖不了时返回 undefined
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  protected scriptedFallbackReply(userText: string, behaviorContext: BehaviorContext): string | undefined {
    return this.scriptedFallbackResponse(userText, behaviorContext, this.context.functionDescriptors)?.text;
  }

  /** 离线模型的通用结构化上下文兜底，不按业务关键词解释事实。 */
  protected scriptedFallbackResponse(userText: string, behaviorContext: BehaviorContext, functionDescriptors: PluginDescriptor[] = this.context.functionDescriptors, resolvedReferences: ResolvedFactReference[] = [], reasonCode = 'unknown', referenceCandidates: VerifiedFactRecord[] = []): ScriptedReply | undefined {
    const text = userText.trim();
    const pending = behaviorContext.pending;
    if (pending.status === 'required' && pending.kind === 'selection' && pending.options && text.length <= 60) {
      const selected = pending.options.find((option) => option.key === text);
      if (selected) return { text: `已记录你的选择「${selected.label}」。如果还需要继续处理，请告诉我下一步需求。` };
    }
    if (reasonCode === 'reference_ambiguous' && referenceCandidates.length > 0) return { text: `我找到多个可能的记录，请明确选择第 ${referenceCandidates.map((record) => record.sequence).join('、')} 条中的哪一条。` };
    if (isFactFollowUp(text)) {
      const records = resolvedReferences.length > 0 ? resolvedReferences.map((item) => item.record) : reasonCode === 'reference_unresolved' ? [] : currentFactRecords(behaviorContext);
      if (records.length > 0) return { text: `根据当前会话已确认的信息：${records.flatMap((record) => Object.entries(record.values).map(([field, value]) => `${field}=${String(value ?? '空')}`)).join('、')}。` };
      return { text: '当前会话没有足够的已确认事实。请说明你想查询的对象或需要补充的信息。' };
    }
    if (/(你是谁|你叫什么|自我介绍|你是什么)/.test(text)) {
      return { text: '我是 IAR Agent Sandbox，一个可交互的 IAR 插件沙盒。你输入一句话，我会走完语义抽取、两阶段路由、策略确认和插件执行。当前可用能力：' + describeFunctions(functionDescriptors) };
    }
    if (/(能做什么|会什么|有什么功能|可以做什么|能干嘛|能干什么)/.test(text)) {
      return { text: `我目前可以使用这些已注册能力：${describeFunctions(functionDescriptors)}` };
    }
    return undefined;
  }


  /**
   * 流式回复生成：brain 模式逐段透传 delta，scripted 模式一次性下发模板回复。
   *
   * 流式调用或 iar.response/v1 解析失败时，已 stream 出的原文直接兜底；
   * 一个增量都没收到时退回非流式生成，保持与 turn() 相同的失败话术。
   *
   * @param context - 链路、用户消息与已执行动作结果
   * @param onDelta - 回复增量回调
   * @returns 回复文本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  public async generateReplyStreamed(context: ActionReplyContext, onDelta: (delta: string) => void): Promise<string> {
    const { traceId, runId, userText, behaviorContext, recentMessages, functionDescriptors, action, actionResult } = context;
    if (this.context.mode !== 'brain' || !(this.context.brainProvider instanceof OpenAICompatibleModelProvider)) {
      const reply = await this.generateReply(context);
      onDelta(reply);
      return reply;
    }
    const input: JsonValue = {
      userMessage: userText,
      functionId: action.functionId,
      pluginId: action.pluginId,
      actionStatus: actionResult.status,
      actionOutput: actionResult.output ?? null,
      behaviorContext,
      recentMessages,
      functionDescriptors
    };
    return streamModelReply({ provider: this.context.brainProvider, profile: this.context.registry.forRole('response.generate'), traceId, runId, input, onDelta, onClarification: (clarification) => this.persistClarification(behaviorContext, clarification),
      onInvalid: async () => `动作已执行（${action.functionId}），但回复生成失败（model.schema_invalid）。`, onFailure: () => this.generateReply(context) });
  }


  /**
   * 调用 Response Generator 生成面向用户的回复。
   * 动作已执行后回复失败也要保留执行事实，避免诱导重试。
   * 输出取自受契约约束的模型结果，不直接使用原始响应。
   *
   * @param context - 链路、用户消息与已执行动作结果
   * @returns 回复文本
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async generateReply(context: ActionReplyContext): Promise<string> {
    const { traceId, runId, userText, behaviorContext, recentMessages, functionDescriptors, action, actionResult } = context;
    const generated = await new ResponseGeneratorAdapter(this.context.gateway).generate({
      traceId,
      runId,
      input: {
        userMessage: userText,
        functionId: action.functionId,
        pluginId: action.pluginId,
        actionStatus: actionResult.status,
        actionOutput: actionResult.output ?? null,
        behaviorContext,
        recentMessages,
        functionDescriptors
      }
    });
    if (!generated.ok) return `动作已执行（${action.functionId}），但回复生成失败（${generated.error.code}）。`;
    await this.persistClarification(behaviorContext, generated.value.clarification);
    return generated.value.text;
  }


  /**
   * 记录一条用户消息和对应助手回复到最近消息列表。
   *
   * @param userText - 用户消息
   * @param assistantReply - 助手回复
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public pushMessages(userText: string, assistantReply: string): void {
    const userMessage: SessionMessage = { messageId: `message-${randomUUID()}`, role: 'user', content: userText, occurredAt: new Date().toISOString() };
    this.context.recentMessages.push({ role: userMessage.role, text: boundMessageText(userMessage.content, this.context.recentMessageMaxChars) });
    this.context.recordMessage?.(userMessage);
    this.pushAssistantMessage(assistantReply);
  }


  /**
   * 记录一条助手回复，最近消息列表按上限截断。
   *
   * @param assistantReply - 助手回复
   * @returns 无返回值
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public pushAssistantMessage(assistantReply: string): void {
    this.context.recentMessages.push({ role: 'assistant', text: boundMessageText(assistantReply, this.context.recentMessageMaxChars) });
    this.context.recordMessage?.({ messageId: `message-${randomUUID()}`, role: 'assistant', content: assistantReply, occurredAt: new Date().toISOString() });
    if (this.context.recentMessages.length > this.context.recentMessageLimit) this.context.recentMessages.splice(0, this.context.recentMessages.length - this.context.recentMessageLimit);
  }
}

/** 只从当前 Plugin 描述生成能力说明，不维护业务功能清单。 */
function describeFunctions(functionDescriptors: PluginDescriptor[]): string {
  if (functionDescriptors.length === 0) return '当前没有可用能力。';
  return functionDescriptors.map((descriptor, index) => `${String(index + 1)}）${descriptor.description}`).join('；');
}

/** 将进入模型窗口的消息限制在稳定的字符边界内。 */
function boundMessageText(text: string, maxChars: number): string {
  return text.slice(0, maxChars);
}

/** 判断用户是否在询问当前会话已经确认的事实，而不是发起新操作。 */
function isFactFollowUp(text: string): boolean {
  return /刚才|之前|上次|前面|上一个|前一个|这个|该|那条|编号|单号|结果|进度|状态|多少|哪个|第几个|第几位|哪一位|排名|排队|位置|位次|顺序/.test(text);
}

/** 读取当前事实焦点，避免未声明顺序关系时把整条事实链暴露给回复。 */
function currentFactRecords(context: BehaviorContext): Array<NonNullable<BehaviorContext['factHistory']>['records'][number]> {
  const history = context.factHistory;
  if (!history) return [];
  const focus = history.focusRecordId ? history.records.find((record) => record.recordId === history.focusRecordId) : undefined;
  const latest = history.records.at(-1);
  return focus ? [focus] : latest ? [latest] : [];
}
