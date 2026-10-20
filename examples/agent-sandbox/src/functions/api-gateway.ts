/**
 * 提供 API 网关管理（api.gateway）Function 插件。
 *
 * 模拟企业数据平台的 API 网关子系统：search 从本地网关知识库做确定性
 * 检索返回 top3（带 score 与 answer），stats 返回本地确定性调用统计，
 * limit 模拟调整限流配额并返回受理号，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余按 query 关键词推断。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** api.gateway 的确定性网关统计 fixture。 */
const GATEWAY_STATS: Record<string, JsonValue> = {
  window: '最近 5 分钟',
  qps: 2380,
  successRate: '99.95%',
  p99Latency: '186ms',
  rejected: 12,
  topCallers: [
    { app: 'order-center', qps: 620, share: '26%' },
    { app: 'user-portal', qps: 455, share: '19%' },
    { app: 'open-platform', qps: 310, share: '13%' }
  ]
};

/** api.gateway 的显式操作目录。 */
export const apiGatewayOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索 API 网关知识库，返回相关度最高的 3 条说明' },
  { name: 'stats', kind: 'read', description: '查看网关调用量、成功率、延迟与拒绝请求的统计' },
  { name: 'limit', kind: 'action', description: '调整指定应用或接口的限流配额' }
];

/** api.gateway 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const apiGatewayManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'api-gateway-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'api.gateway',
  version: '1.0.0',
  description: 'API 网关管理插件，提供调用统计查看与限流调整的确定性模拟',
  actionTypes: ['query', 'update'],
  operations: apiGatewayOperations,
  capabilities: ['gateway.read', 'gateway.control'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/api-gateway.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['gateway.read', 'gateway.control'] },
  dependencies: []
};

/**
 * operation 缺省时按 query 关键词推断默认 read 操作。
 *
 * @param query - 用户查询文本
 * @returns 推断出的操作名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function inferOperation(query: string): string {
  // 只有出现明确的调整动词才推断为动作操作，避免"限流策略有哪些"这类咨询被当成调整请求。
  return /调整|修改|设为|改成|调到|提高|降低|提额/.test(query) ? 'limit' : 'stats';
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
 * 处理网关知识检索、统计查询与限流调整，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const apiGatewayHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('gateway.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : inferOperation(parsed.query));
  const op = findSandboxOperation(apiGatewayOperations, operation);
  if (!op) return fail('gateway.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('gateway.query_required');
    const results = retrieveKnowledge('api.gateway', parsed.query, 3);
    return succeed('search', { results, summary: `API 网关知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'stats') {
    return succeed('stats', { stats: GATEWAY_STATS, summary: `网关近 5 分钟 QPS ${String(GATEWAY_STATS.qps)}，成功率 ${String(GATEWAY_STATS.successRate)}，P99 ${String(GATEWAY_STATS.p99Latency)}` });
  }
  const target = parsed.params.target ?? (/订单/.test(parsed.query) ? 'order-center' : 'user-portal');
  const rateMatch = parsed.query.match(/(\d+)\s*(?:次|\/\s*s|\/\s*秒|qps)/i) ?? parsed.query.match(/(\d+)/);
  const rate = parsed.params.rate ?? (rateMatch ? `${rateMatch[1]}/s` : '300/s');
  return succeed('limit', {
    receipt: `gateway-limit-${target}`,
    target,
    newLimit: rate,
    summary: `已受理调整「${target}」限流配额为 ${rate}，约 5 分钟内生效`
  }, { receipt: `gateway-limit-${target}`, target, newLimit: rate });
};

/** 可直接交给 PluginHost.install 的 api.gateway 注册对象。 */
export const apiGatewayPlugin: PluginRegistration = { manifest: apiGatewayManifest, handler: apiGatewayHandler };
