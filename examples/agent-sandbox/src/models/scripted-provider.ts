/**
 * 提供离线确定性 ModelProvider 实现（scripted 模式）。
 *
 * 该 provider 不访问任何外部服务，用关键词匹配模拟语义抽取：
 * 十个企业数据平台子系统（intent 即 functionId），各配 3~6 个中文
 * 关键词/句式，并抽取 slots.operation / slots.query；response.generate
 * 按子系统中文名生成模板化中文回复；context.compact 返回基于输入的
 * 确定性摘要。输出结构与 brain provider 完全一致，保证同一 gateway
 * 校验路径可复用。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { JsonValue } from '@iar/contracts';
import type { PluginDescriptor } from '@iar/plugin-host';
import { REQUIRED_PRESERVED_FACTS } from '@iar/contracts';
import type { ModelProvider, ModelProviderRequest } from '@iar/decision';

/** 压缩 state 片段允许保留的白名单字段。 */
const STATE_FIELD_WHITELIST = ['subject', 'intent', 'action', 'route', 'slots', 'workflow', 'pending', 'confirmation', 'clarification'] as const;

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
    if (request.profile.role === 'semantic.extract') return this.extract(readString(input, 'text') ?? '', asRecord(input.behaviorContext));
    if (request.profile.role === 'context.compact') return this.compact(input);
    return this.generate(input);
  }

  /**
   * 关键词匹配抽取 SemanticFrame，覆盖十个子系统。
   *
   * 匹配顺序从语义最具体的子系统到最泛化的知识问答，避免宽泛词
   * （如「查」「怎么」）抢先命中；operation 槽位在检测到明确的动作
   * 或子操作关键词时给出，缺省时由 handler 端推断默认 read 操作。
   *
   * @param text - 用户输入文本
   * @returns iar.semantic-frame/v2 或兼容 v1 的结构
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private extract(text: string, behaviorContext: Record<string, unknown>): unknown {
    const trimmed = text.trim();
    if (trimmed.length === 0) return frame('unknown', {}, 0.1, 'unknown');
    // 已有可信事实的追问优先交给通用回复模型，不能因业务名词重复触发默认动作。
    if (hasVerifiedFacts(behaviorContext) && isFactFollowUp(trimmed) && !isExplicitNewOperation(trimmed)) return frame('unknown', {}, 0.95, 'query', historicalReference(trimmed));
    // howTo 用于区分「如何/怎么/怎样」类咨询与真正的动作请求。
    const howTo = /(如何|怎么|怎样)/.test(trimmed);
    // 人工优先于工单和查询，避免“转人工查问题”被误判。
    if (/(转人工|人工客服|真人客服|人工服务|找人工)/.test(trimmed)) {
      return frame('human.transfer', { operation: 'transfer', query: trimmed }, 0.97);
    }
    if (/(工单|报障|故障)/.test(trimmed)) {
      if (/(进度|进展|状态|查询|查一下|到哪|怎么样)/.test(trimmed)) return frame('ticket.create', { operation: 'progress', query: trimmed }, 0.94);
      return frame('ticket.create', { operation: 'create', query: trimmed }, 0.95);
    }
    if (/(DIP|数据集成|集成任务|同步任务)/.test(trimmed)) {
      if (!howTo && /(重跑|重新跑|再跑|rerun)/i.test(trimmed)) return frame('dip.manage', { operation: 'rerun', query: trimmed }, 0.96);
      if (!howTo && /(停止|停掉|暂停)/.test(trimmed)) return frame('dip.manage', { operation: 'stop', query: trimmed }, 0.96);
      if (/(详情|明细|配置)/.test(trimmed)) return frame('dip.manage', { operation: 'detail', query: trimmed }, 0.94);
      return frame('dip.manage', { operation: 'list', query: trimmed }, 0.93);
    }
    if (/(调度|跑批|定时任务|任务|job)/i.test(trimmed)) {
      if (/(日志|log)/i.test(trimmed)) return frame('job.monitor', { operation: 'logs', query: trimmed }, 0.94);
      return frame('job.monitor', { operation: 'status', query: trimmed }, 0.93);
    }
    if (/(网关|限流)/.test(trimmed) || /API/.test(trimmed)) {
      if (!howTo && /(限流|调整|修改|提额)/.test(trimmed)) return frame('api.gateway', { operation: 'limit', query: trimmed }, 0.94);
      return frame('api.gateway', { operation: 'stats', query: trimmed }, 0.92);
    }
    if (/(报表|报告|看板|日报|周报|月报)/.test(trimmed)) {
      if (!howTo && /(导出|下载)/.test(trimmed)) return frame('report.center', { operation: 'export', query: trimmed }, 0.95);
      return frame('report.center', { operation: 'list', query: trimmed }, 0.92);
    }
    if (/(系统状态|服务状态|整体状态|状态如何|状态怎么样|运行情况|告警|报警|公告|挂了|宕机|不可用|健康)/.test(trimmed)) {
      if (/(告警|报警)/.test(trimmed)) return frame('system.status', { operation: 'alerts', query: trimmed }, 0.94);
      return frame('system.status', { operation: 'overview', query: trimmed }, 0.93);
    }
    if (!howTo && /(权限|授权|角色|账号|账户)/.test(trimmed)) {
      if (/(申请|开通|提权)/.test(trimmed)) return frame('account.privilege', { operation: 'grant', query: trimmed }, 0.95);
      return frame('account.privilege', { operation: 'mine', query: trimmed }, 0.92);
    }
    if (/(搜表|查表|找表|数据表|宽表|用户表|订单表|商品表|指标|血缘)/.test(trimmed)) {
      if (/(血缘|上下游|来源)/.test(trimmed)) return frame('dataset.query', { operation: 'lineage', query: trimmed }, 0.95);
      return frame('dataset.query', { operation: 'search', query: trimmed }, 0.94);
    }
    if (/(知识|查一下|查下|是什么|什么是|如何|怎么|为什么|政策|规范|资料|帮助|多少)/.test(trimmed)) {
      return frame('knowledge.query', { query: trimmed }, 0.9);
    }
    return frame('unknown', {}, 0.3, 'unknown');
  }

  /**
   * 生成基于输入事件的确定性压缩结果。
   *
   * @param input - behaviorContext 和 eventsToCompact
   * @returns iar.compaction-result/v1 结构，state 按白名单保留
   * @author lvdaxianer@yeah.net
   * @date 2026-10-17
   */
  private compact(input: Record<string, unknown>): unknown {
    const context = asRecord(input.behaviorContext);
    const events = Array.isArray(input.eventsToCompact) ? input.eventsToCompact : [];
    const state: Record<string, unknown> = {};
    for (const field of STATE_FIELD_WHITELIST) {
      if (context[field] !== undefined) state[field] = context[field];
    }
    return {
      schemaVersion: 'iar.compaction-result/v1',
      summary: `会话已产生 ${String(events.length)} 条结构化事件，可信事实及其来源由运行时保留。`,
      state,
      references: [],
      preservedFacts: [...REQUIRED_PRESERVED_FACTS],
      warnings: []
    };
  }

  /**
   * 按执行结果生成模板化中文回复，提及对应子系统中文名。
   *
   * @param input - userMessage、functionId、actionStatus 和 actionOutput
   * @returns iar.response/v1 结构
   * @author lvdaxianer@yeah.net
   * @date 2026-10-18
   */
  private generate(input: Record<string, unknown>): unknown {
    const functionId = readString(input, 'functionId') ?? 'unknown';
    const status = readString(input, 'actionStatus') ?? 'unknown';
    const output = asRecord(input.actionOutput);
    const descriptors = Array.isArray(input.functionDescriptors) ? input.functionDescriptors.filter(isRecord) as unknown as PluginDescriptor[] : [];
    const subsystem = descriptors.find((descriptor) => descriptor.functionId === functionId)?.description ?? functionId;
    let text: string;
    if (status !== 'succeeded') {
      text = `【${subsystem}】动作执行失败（${typeof output.errorCode === 'string' ? output.errorCode : 'unknown'}），请稍后重试。`;
    } else {
      const operation = readString(output, 'operation') ?? '';
      const summary = readString(output, 'summary') ?? '';
      const receipt = readString(output, 'receipt');
      if (operation === 'search') {
        const results = Array.isArray(output.results) ? output.results.filter(isRecord) : [];
        if (results.length === 0) {
          text = `【${subsystem}】没有检索到匹配的内容，可以换个关键词再试。`;
        } else {
          const lines = results.slice(0, 3).map((item, index) => {
            const score = typeof item.score === 'number' ? item.score.toFixed(2) : '0.00';
            return `${String(index + 1)}. ${readString(item, 'title') ?? ''}：${readString(item, 'answer') ?? ''}（相关度 ${score}）`;
          });
          text = `【${subsystem}】为你找到 ${String(results.length)} 条相关内容：\n${lines.join('\n')}`;
        }
      } else if (receipt !== undefined) {
        text = `【${subsystem}】${summary || '操作已受理'} 受理号 ${receipt}。`;
      } else {
        text = `【${subsystem}】${summary || '操作已完成'}`;
      }
    }
    return { schemaVersion: 'iar.response/v1', text };
  }
}

/** 判断结构化上下文中是否存在可供追问使用的 verified 事实。 */
function hasVerifiedFacts(context: Record<string, unknown>): boolean {
  const history = context.factHistory;
  return isRecord(history) && Array.isArray(history.records) && history.records.length > 0;
}

/** 判断用户是否在追问已有结果，而非表达新副作用。 */
function isFactFollowUp(text: string): boolean {
  return /刚才|之前|上次|前面|上一个|前一个|当前|这个|该|那条|编号|单号|结果|进度|状态|多少|哪个|第几个|第几位|哪一位|什么位置|位次/.test(text);
}

/** 判断当前句子是否明确要求重新执行一个新操作。 */
function isExplicitNewOperation(text: string): boolean {
  return /帮我|请帮|我要|我想|请你|执行|重新|再次|再来|重新创建|重新提交/.test(text);
}

/**
 * 构造 SemanticFrame 输出。
 *
 * @param intent - 结构化意图
 * @param slots - 抽取到的槽位
 * @param confidence - 模型置信度
 * @returns iar.semantic-frame/v2 或兼容 v1 的结构
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
type ScriptedAction = 'query' | 'create' | 'update' | 'delete' | 'transfer' | 'execute' | 'unknown';

function frame(intent: string, slots: Record<string, JsonValue>, confidence: number, action?: ScriptedAction, references: Array<Record<string, JsonValue>> = []): unknown {
  return { schemaVersion: references.length > 0 ? 'iar.semantic-frame/v2' : 'iar.semantic-frame/v1', intent, action: action ?? inferAction(intent, slots), slots, references, confidence };
}

/** 将自然语言顺序词归一化为不透明事实链关系。 */
function historicalReference(text: string): Array<Record<string, JsonValue>> {
  if (/上一个|前一个|上一条|前一条|上次/.test(text)) return [{ text, relation: 'previous', scope: 'same_fact_chain' }];
  if (/下一个|后一个|下一条|后一次/.test(text)) return [{ text, relation: 'next', scope: 'same_fact_chain' }];
  if (/第一个|第一条|最早/.test(text)) return [{ text, relation: 'first', scope: 'same_fact_chain' }];
  if (/最后一个|最后一条|最近一个/.test(text)) return [{ text, relation: 'last', scope: 'same_fact_chain' }];
  return [{ text, relation: 'current', scope: 'same_fact_chain' }];
}

/** 离线 provider 只模拟固定动作协议，不把业务词映射写入运行时路由。 */
function inferAction(intent: string, slots: Record<string, JsonValue>): ScriptedAction {
  if (intent === 'unknown') return 'unknown';
  const operation = typeof slots.operation === 'string' ? slots.operation : undefined;
  if (!operation) return 'query';
  if (operation === 'create') return 'create';
  if (operation === 'transfer') return 'transfer';
  if (operation === 'grant' || operation === 'limit') return 'update';
  if (operation === 'rerun' || operation === 'stop' || operation === 'export') return 'execute';
  return 'query';
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
