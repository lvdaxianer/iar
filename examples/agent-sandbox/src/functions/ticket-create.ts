/**
 * 提供工单支持（ticket.create）Function 插件。
 *
 * 模拟企业数据平台的工单子系统：search 从本地工单知识库做确定性检索
 * 返回 top3（带 score 与 answer），progress 返回本地确定性工单流转 fixture，
 * create 模拟提交工单并返回受理号，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余按 query 关键词在 progress/create 之间推断。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** ticket.create 的确定性工单流转 fixture，按工单号索引。 */
const TICKET_PROGRESS: Readonly<Record<string, Record<string, JsonValue>>> = {
  'ticket-20261018-001': {
    ticketId: 'ticket-20261018-001',
    title: '报表导出失败报错 500',
    status: '处理中',
    timeline: [
      { time: '2026-10-18 09:12:00', node: '已创建', note: '用户提交工单' },
      { time: '2026-10-18 09:40:00', node: '待受理', note: '分诊到报表服务队列' },
      { time: '2026-10-18 10:05:00', node: '处理中', note: '工程师正在排查导出队列积压' }
    ]
  },
  'ticket-20261017-006': {
    ticketId: 'ticket-20261017-006',
    title: '申请开通 dim_user 查询权限',
    status: '已解决',
    timeline: [
      { time: '2026-10-17 14:20:00', node: '已创建', note: '用户提交权限申请' },
      { time: '2026-10-17 15:00:00', node: '处理中', note: '数据负责人审批通过' },
      { time: '2026-10-17 15:30:00', node: '已解决', note: '权限已生效并通知用户' }
    ]
  }
};

/** 默认展示进度的工单号。 */
const DEFAULT_TICKET_ID = 'ticket-20261018-001';

/** 新建工单的确定性编号（模拟单次会话内的递增）。 */
let ticketSeq = 7;

/** ticket.create 的显式操作目录。 */
export const ticketCreateOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索工单支持知识库，返回相关度最高的 3 条说明' },
  { name: 'progress', kind: 'read', description: '按工单号查询工单的流转节点与处理进展' },
  { name: 'create', kind: 'action', description: '提交新工单并返回工单编号' }
];

/** ticket.create 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const ticketCreateManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'ticket-create-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'ticket.create',
  version: '1.0.0',
  description: '工单支持插件，提供工单进度查询与工单创建的确定性模拟',
  capabilities: ['ticket.read', 'ticket.write'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/ticket-create.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['ticket.read', 'ticket.write'] },
  dependencies: []
};

/**
 * operation 缺省时按 query 关键词推断操作。
 *
 * @param query - 用户查询文本
 * @returns 推断出的操作名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function inferOperation(query: string): string {
  return /进度|状态|查询|到哪/.test(query) ? 'progress' : 'create';
}

/**
 * 判断 query 是否为知识型问法，用于 operation 缺省时优先默认 search。
 *
 * @param query - 用户查询文本
 * @returns query 非空且命中知识型关键词时返回 true
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function isKnowledgeQuery(query: string): boolean {
  return query.trim().length > 0 && /为什么|如何|怎么|什么是|有哪些|原因|排查|处理|介绍|说明|区别|失败/.test(query);
}

/**
 * 处理工单知识检索、进度查询与工单创建，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const ticketCreateHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('ticket.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : inferOperation(parsed.query));
  const op = findSandboxOperation(ticketCreateOperations, operation);
  if (!op) return fail('ticket.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('ticket.query_required');
    const results = retrieveKnowledge('ticket.create', parsed.query, 3);
    return succeed('search', { results, summary: `工单支持知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'progress') {
    const ticketId = parsed.params.ticketId ?? (/20261017/.test(parsed.query) ? 'ticket-20261017-006' : DEFAULT_TICKET_ID);
    const ticket = TICKET_PROGRESS[ticketId];
    if (!ticket) return fail('ticket.not_found');
    return succeed('progress', { ticket, summary: `工单 ${ticketId} 当前节点「${String(ticket.status)}」，共 ${String((ticket.timeline as unknown[]).length)} 条流转记录` }, { ticketId, status: String(ticket.status ?? 'unknown') });
  }
  const title = parsed.params.title ?? parsed.query.slice(0, 30);
  const description = parsed.query.trim().length > 0 ? parsed.query : title;
  const priorityRaw = parsed.params.priority;
  const priority = priorityRaw === 'low' || priorityRaw === 'medium' || priorityRaw === 'high' ? priorityRaw : 'medium';
  ticketSeq += 1;
  const ticketId = `ticket-20261018-${String(ticketSeq).padStart(3, '0')}`;
  return succeed('create', {
    receipt: ticketId,
    ticketId,
    title: title.slice(0, 120),
    description: description.slice(0, 2000),
    priority,
    status: 'created',
    summary: `工单已创建并进入分诊队列，标题「${title.slice(0, 30)}」，优先级 ${priority}`
  }, { receipt: ticketId, ticketId, priority, status: 'created' });
};

/** 可直接交给 PluginHost.install 的 ticket.create 注册对象。 */
export const ticketCreatePlugin: PluginRegistration = { manifest: ticketCreateManifest, handler: ticketCreateHandler };
