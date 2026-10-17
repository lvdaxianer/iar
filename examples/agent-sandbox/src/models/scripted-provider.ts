/**
 * 提供离线确定性 ModelProvider 实现（scripted 模式）。
 *
 * 该 provider 不访问任何外部服务，用关键词匹配模拟语义抽取：
 * 查/知识/退款 → knowledge.query，工单 → ticket.create，人工 → human.transfer；
 * response.generate 返回模板化中文回复；context.compact 返回基于输入的确定性摘要。
 * 输出结构与 brain provider 完全一致，保证同一 gateway 校验路径可复用。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { JsonValue } from '@iar/contracts';
import { REQUIRED_PRESERVED_FACTS } from '@iar/contracts';
import type { ModelProvider, ModelProviderRequest } from '@iar/decision';

/** 会话消息的最小形状。 */
type SandboxMessage = { role: string; text: string };

/** 压缩 state 片段允许保留的白名单字段。 */
const STATE_FIELD_WHITELIST = ['subject', 'intent', 'action', 'route', 'slots', 'workflow', 'pending', 'confirmation'] as const;

/**
 * 用关键词规则模拟真实模型的离线 provider。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export class ScriptedModelProvider implements ModelProvider {
  /**
   * 按 role 返回确定性的结构化输出。
   *
   * @param request - gateway 冻结的 provider 请求
   * @returns 与 brain provider 结构一致的 JSON 输出
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  public async complete(request: ModelProviderRequest): Promise<unknown> {
    const input = asRecord(request.input);
    if (request.profile.role === 'semantic.extract') return this.extract(readString(input, 'text') ?? '');
    if (request.profile.role === 'context.compact') return this.compact(input);
    return this.generate(input);
  }

  /**
   * 关键词匹配抽取 SemanticFrame。
   *
   * @param text - 用户输入文本
   * @returns iar.semantic-frame/v1 结构
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private extract(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return frame('unknown', {}, 0.1);
    // 人工优先于工单和查询，避免“转人工查问题”被误判为知识查询。
    if (/(人工|客服|真人)/.test(trimmed)) {
      return frame('human.transfer', { reason: '用户主动请求人工协助', summary: trimmed }, 0.96);
    }
    if (/(工单|报障|提单|故障)/.test(trimmed)) {
      return frame('ticket.create', { title: trimmed.slice(0, 30), description: trimmed, priority: 'medium' }, 0.94);
    }
    if (/(查|知识|退款|政策|怎么|如何|是什么|多少)/.test(trimmed)) {
      return frame('knowledge.query', { query: trimmed }, 0.92);
    }
    return frame('unknown', {}, 0.3);
  }

  /**
   * 生成基于输入事件的确定性压缩结果。
   *
   * @param input - behaviorContext、eventsToCompact 和 recentMessages
   * @returns iar.compaction-result/v1 结构，state 按白名单保留
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private compact(input: Record<string, unknown>): unknown {
    const context = asRecord(input.behaviorContext);
    const events = Array.isArray(input.eventsToCompact) ? input.eventsToCompact : [];
    const messages: SandboxMessage[] = (Array.isArray(input.recentMessages) ? input.recentMessages : [])
      .filter(isRecord)
      .map((message) => ({ role: String(message.role ?? 'unknown'), text: String(message.text ?? '') }));
    const recentTexts = messages.slice(-3).map((message) => `${message.role}: ${message.text}`).join('；');
    const state: Record<string, unknown> = {};
    for (const field of STATE_FIELD_WHITELIST) {
      if (context[field] !== undefined) state[field] = context[field];
    }
    return {
      schemaVersion: 'iar.compaction-result/v1',
      summary: `会话已产生 ${String(events.length)} 条事件、${String(messages.length)} 条消息。最近对话：${recentTexts || '无'}。`,
      state,
      references: [],
      preservedFacts: [...REQUIRED_PRESERVED_FACTS],
      warnings: []
    };
  }

  /**
   * 按执行结果生成模板化中文回复。
   *
   * @param input - userMessage、functionId、actionStatus 和 actionOutput
   * @returns iar.response/v1 结构
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private generate(input: Record<string, unknown>): unknown {
    const functionId = readString(input, 'functionId') ?? 'unknown';
    const status = readString(input, 'actionStatus') ?? 'unknown';
    const output = asRecord(input.actionOutput);
    let text: string;
    if (status !== 'succeeded') {
      text = `动作执行失败（${typeof output.errorCode === 'string' ? output.errorCode : 'unknown'}），请稍后重试。`;
    } else if (functionId === 'knowledge.query') {
      text = `已为你查询到相关知识：${readString(output, 'answer') ?? '（无内容）'}（置信度 ${typeof output.confidence === 'number' ? output.confidence.toFixed(2) : '0.00'}）`;
    } else if (functionId === 'ticket.create') {
      text = `工单已创建，编号 ${readString(output, 'ticketId') ?? 'unknown'}。`;
    } else if (functionId === 'human.transfer') {
      text = `已为你转接人工客服，受理号 ${readString(output, 'handoffId') ?? 'unknown'}。`;
    } else {
      text = '动作已执行完成。';
    }
    return { schemaVersion: 'iar.response/v1', text };
  }
}

/**
 * 构造 SemanticFrame 输出。
 *
 * @param intent - 结构化意图
 * @param slots - 抽取到的槽位
 * @param confidence - 模型置信度
 * @returns iar.semantic-frame/v1 结构
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function frame(intent: string, slots: Record<string, JsonValue>, confidence: number): unknown {
  return { schemaVersion: 'iar.semantic-frame/v1', intent, slots, references: [], confidence };
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

/**
 * 判断未知值是否为普通对象。
 *
 * @param value - 未知值
 * @returns 是否为非数组对象
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
