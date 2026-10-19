/** 模型回复和最近消息历史。
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { ActionDefinition, ActionResult, BehaviorContext, JsonValue, PendingInput } from '@iar/contracts';
import { ResponseGeneratorAdapter, type ClarificationMetadata, type ModelGateway, type ModelProfileRegistry } from '@iar/decision';
import { sandboxFunctionIds } from './functions/index.js';
import { OpenAICompatibleModelProvider, type BrainModelProvider } from './models/llm-provider.js';
import type { ScriptedModelProvider } from './models/scripted-provider.js';
import { SandboxSessionCompaction, type CompactionContext } from './session-compaction.js';
import type { CompactResult, SandboxMode } from './session-types.js';
import { FALLBACK_REPLY_TEXT } from './session-core.js';
import { streamModelReply } from './session-model-stream.js';

/** 模型回复所需的运行和输入上下文。
 * traceId 与 runId 继承当前轮次，不创建新的会话身份。
 * 所有回复路径共享同一个输入形状，避免普通和流式入口漂移。
 */
type ReplyContext = { traceId: string; runId: string; userText: string; behaviorContext: BehaviorContext };
type FallbackContext = ReplyContext & { reasonCode: string };
type ActionReplyContext = ReplyContext & { action: ActionDefinition; actionResult: ActionResult };

/** 回复及压缩只访问宿主状态，重置后所有访问器指向当前会话。 */
export type SessionRepliesContext = CompactionContext & {
  mode: SandboxMode;
  brainProvider: BrainModelProvider | ScriptedModelProvider;
  registry: ModelProfileRegistry;
  gateway: ModelGateway;
  updateClarification: (pending: PendingInput) => Promise<void>;
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
    const { traceId, runId, userText, behaviorContext, reasonCode } = context;
    if (this.context.mode === 'brain') {
      const generated = await new ResponseGeneratorAdapter(this.context.gateway).generate({
        traceId,
        runId,
        input: {
          userMessage: userText,
          behaviorContext,
          availableFunctions: [...sandboxFunctionIds],
          reasonCode
        }
      });
      // 只有生成失败才回退固定话术。
      if (generated.ok) {
        await this.persistClarification(behaviorContext, generated.value.clarification);
        return generated.value.text;
      }
      return FALLBACK_REPLY_TEXT;
    }
    const scripted = this.scriptedFallbackResponse(userText, behaviorContext);
    await this.persistClarification(behaviorContext, scripted?.clarification);
    return scripted?.text ?? FALLBACK_REPLY_TEXT;
  }

  /** 将模型通过契约返回的澄清元数据转换为可重放 pending 事件。 */
  private async persistClarification(context: BehaviorContext, clarification: ClarificationMetadata | undefined): Promise<void> {
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
    const { traceId, runId, userText, behaviorContext, reasonCode } = context;
    if (this.context.mode !== 'brain' || !(this.context.brainProvider instanceof OpenAICompatibleModelProvider)) {
      const reply = await this.fallbackReply(context);
      onDelta(reply);
      return reply;
    }
    const input: JsonValue = {
      userMessage: userText,
      behaviorContext,
      availableFunctions: [...sandboxFunctionIds],
      reasonCode
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
    return this.scriptedFallbackResponse(userText, behaviorContext)?.text;
  }

  /** 离线模型的通用结构化上下文兜底，不按业务关键词解释事实。 */
  protected scriptedFallbackResponse(userText: string, behaviorContext: BehaviorContext): ScriptedReply | undefined {
    const text = userText.trim();
    const pending = behaviorContext.pending;
    if (pending.status === 'required' && pending.kind === 'selection' && pending.options && text.length <= 60) {
      const selected = pending.options.find((option) => option.key === text);
      if (selected) return { text: `已记录你的选择「${selected.label}」。如果还需要继续处理，请告诉我下一步需求。` };
    }
    if (isFactFollowUp(text)) {
      const facts = Object.values(behaviorContext.facts ?? {}).filter((fact) => fact.status === 'verified');
      if (facts.length > 0) return { text: `根据当前会话已确认的信息：${facts.map((fact) => `${fact.field}=${String(fact.value ?? '空')}`).join('、')}。` };
      return { text: '当前会话没有足够的已确认事实。请说明你想查询的对象或需要补充的信息。' };
    }
    if (/(你是谁|你叫什么|自我介绍|你是什么)/.test(text)) {
      return { text: '我是 IAR Agent Sandbox，一个可交互的 IAR 插件沙盒。当前模拟的企业数据平台包含 10 个子系统：平台通用知识、数据集成管理（DIP）、任务调度监控、API 网关管理、数据资产目录、报表中心、系统状态与告警、账户与权限、工单支持和人工服务。你输入一句话，我会走完语义抽取、两阶段路由（Function → Plugin）、策略确认和插件执行，并在右侧展示完整的路由证据和事件流。' };
    }
    if (/(能做什么|会什么|有什么功能|可以做什么|能干嘛|能干什么)/.test(text)) {
      return { text: '我目前支持十项能力：1）平台知识问答，如「如何申请数据权限」；2）数据集成管理，如「列出今天的集成任务」，重跑/停止需确认；3）任务调度监控，如「订单汇总 Job 跑完了吗」；4）API 网关管理，如「查看网关调用统计」，调整限流需确认；5）数据资产检索，如「搜一下用户表」；6）报表中心，如「列出销售报表」，导出需确认；7）系统状态与告警，如「现在有哪些告警」；8）账户与权限，如「我有哪些权限」，申请授权需确认；9）工单支持，如「帮我提个工单，网络很卡」；10）人工服务，如「转人工」，转接需确认。' };
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
    const { traceId, runId, userText, behaviorContext, action, actionResult } = context;
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
      behaviorContext
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
    const { traceId, runId, userText, behaviorContext, action, actionResult } = context;
    const generated = await new ResponseGeneratorAdapter(this.context.gateway).generate({
      traceId,
      runId,
      input: {
        userMessage: userText,
        functionId: action.functionId,
        pluginId: action.pluginId,
        actionStatus: actionResult.status,
        actionOutput: actionResult.output ?? null,
        behaviorContext
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
    this.context.recentMessages.push({ role: 'user', text: userText });
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
    this.context.recentMessages.push({ role: 'assistant', text: assistantReply });
    if (this.context.recentMessages.length > 20) this.context.recentMessages.splice(0, this.context.recentMessages.length - 20);
  }
}

/** 判断用户是否在询问当前会话已经确认的事实，而不是发起新操作。 */
function isFactFollowUp(text: string): boolean {
  return /刚才|之前|上次|前面|这个|该|那条|编号|单号|结果|进度|状态|多少|哪个|排名|排队|第几位|位置|位次|顺序/.test(text);
}
