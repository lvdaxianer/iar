/**
 * 提供人工服务（human.transfer）Function 插件。
 *
 * 模拟企业数据平台的人工服务子系统：search 从本地人工服务知识库做确定性
 * 检索返回 top3（带 score 与 answer），transfer 模拟转接人工队列并返回
 * 受理号，不产生真实副作用；operation 缺省时知识型问法默认 search，
 * 其余默认 transfer（action，需确认）。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugins';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** human.transfer 的显式操作目录。 */
export const humanTransferOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索人工服务知识库，返回相关度最高的 3 条说明' },
  { name: 'transfer', kind: 'action', description: '转接人工客服队列，由人工协助处理当前问题' }
];

/** human.transfer 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const humanTransferManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'human-transfer-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'human.transfer',
  version: '1.0.0',
  description: '人工服务插件，提供转接人工客服队列的确定性模拟',
  actionTypes: ['query', 'transfer'],
  operations: humanTransferOperations,
  capabilities: ['human.transfer'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/human-transfer.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['human.transfer'] },
  dependencies: []
};

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
 * 处理人工服务知识检索与转接受理，返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 检索结果、转接受理结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const humanTransferHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('human.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : 'transfer');
  if (!findSandboxOperation(humanTransferOperations, operation)) return fail('human.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('human.query_required');
    const results = retrieveKnowledge('human.transfer', parsed.query, 3);
    return succeed('search', { results, summary: `人工服务知识库检索完成，命中 ${String(results.length)} 条` });
  }
  const reason = parsed.params.reason ?? '用户主动请求人工协助';
  const summary = parsed.query.trim().length > 0 ? parsed.query : '用户请求人工协助';
  return succeed('transfer', {
    receipt: 'handoff-20261018-001',
    handoffId: 'handoff-20261018-001',
    queue: 'human.support',
    reason: reason.slice(0, 240),
    summary: `已为你转接人工客服（${summary.slice(0, 60)}），当前排队第 3 位`
  }, { receipt: 'handoff-20261018-001', handoffId: 'handoff-20261018-001', queue: 'human.support', queuePosition: 3 });
};

/** 可直接交给 PluginHost.install 的 human.transfer 注册对象。 */
export const humanTransferPlugin: PluginRegistration = { manifest: humanTransferManifest, handler: humanTransferHandler };
