/**
 * 提供数据资产目录（dataset.query）Function 插件。
 *
 * 模拟企业数据平台的数据资产子系统：search 从本地资产知识库做确定性
 * 检索返回 top3（带 score 与 answer），lineage 返回本地确定性血缘 fixture。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** dataset.query 的确定性血缘 fixture，按表名索引。 */
const LINEAGE_FIXTURES: Readonly<Record<string, Record<string, JsonValue>>> = {
  dim_user: {
    table: 'dim_user',
    upstream: ['CRM 主数据（MySQL binlog）', 'dip-task-user-sync 集成任务'],
    downstream: ['dws_user_gmv_1d 汇总表', '经营周报-用户增长页签', 'open-platform /v1/users 接口']
  },
  dwd_order: {
    table: 'dwd_order',
    upstream: ['订单中心（binlog）', 'dip-task-order-sync 集成任务'],
    downstream: ['dws_order_summary 汇总表', 'GMV 指标', '销售日报']
  },
  dim_sku: {
    table: 'dim_sku',
    upstream: ['商品中心（每日全量）', 'dip-task-goods-sync 集成任务'],
    downstream: ['dwd_order 订单明细', '商品 TOP 报表']
  }
};

/** dataset.query 的显式操作目录。 */
export const datasetQueryOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '按表名、指标或关键词检索数据资产目录，返回相关度最高的 3 条说明' },
  { name: 'lineage', kind: 'read', description: '查看指定数据表的上游来源与下游引用血缘' }
];

/** dataset.query 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const datasetQueryManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'dataset-query-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'dataset.query',
  version: '1.0.0',
  description: '数据资产目录插件，提供资产检索与表级血缘查询的确定性模拟',
  actionTypes: ['query'],
  capabilities: ['dataset.read'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/dataset-query.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['dataset.read'] },
  dependencies: []
};

/**
 * 从 params 或 query 关键词推断目标表。
 *
 * @param query - 用户查询文本
 * @param params - 已解析参数
 * @returns 目标表名或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function resolveTable(query: string, params: Record<string, string>): string | undefined {
  if (params.table) return params.table;
  if (/用户/.test(query)) return 'dim_user';
  if (/订单/.test(query)) return 'dwd_order';
  if (/商品|SKU|sku/.test(query)) return 'dim_sku';
  return undefined;
}

/**
 * 处理资产检索与血缘查询，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const datasetQueryHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('dataset.invalid_input');
  const operation = parsed.operation ?? 'search';
  const op = findSandboxOperation(datasetQueryOperations, operation);
  if (!op) return fail('dataset.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('dataset.query_required');
    const results = retrieveKnowledge('dataset.query', parsed.query, 3);
    return succeed('search', { results, summary: `资产目录检索完成，命中 ${String(results.length)} 条` });
  }
  const table = resolveTable(parsed.query, parsed.params);
  const lineage = table ? LINEAGE_FIXTURES[table] : undefined;
  if (!lineage) return fail('dataset.table_not_found');
  return succeed('lineage', {
    lineage,
    summary: `表 ${String(lineage.table)} 上游 ${String((lineage.upstream as unknown[]).length)} 个、下游 ${String((lineage.downstream as unknown[]).length)} 个节点`
  });
};

/** 可直接交给 PluginHost.install 的 dataset.query 注册对象。 */
export const datasetQueryPlugin: PluginRegistration = { manifest: datasetQueryManifest, handler: datasetQueryHandler };
