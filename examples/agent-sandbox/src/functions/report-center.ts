/**
 * 提供报表中心（report.center）Function 插件。
 *
 * 模拟企业数据平台的报表子系统：search 从本地报表知识库做确定性检索
 * 返回 top3（带 score 与 answer），list 返回本地确定性报表目录，
 * export 模拟受控导出并返回受理号，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余默认列出报表目录。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** report.center 的确定性报表目录 fixture。 */
const REPORTS: ReadonlyArray<Record<string, JsonValue>> = [
  { reportId: 'report-sales-daily', name: '销售日报', owner: '交易数据组', updatedAt: '2026-10-18 07:00', refresh: 'T+1', format: 'xlsx/pdf' },
  { reportId: 'report-biz-weekly', name: '经营周报', owner: '经营分析组', updatedAt: '2026-10-13 10:00', refresh: '每周一', format: 'xlsx/pdf' },
  { reportId: 'report-user-growth', name: '用户增长月报', owner: '用户数据组', updatedAt: '2026-10-01 09:00', refresh: '每月 1 日', format: 'xlsx' },
  { reportId: 'report-cu-usage', name: '部门资源消耗报表', owner: '平台运营组', updatedAt: '2026-10-18 06:30', refresh: 'T+1', format: 'csv' }
];

/** report.center 的显式操作目录。 */
export const reportCenterOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索报表中心知识库，返回相关度最高的 3 条说明' },
  { name: 'list', kind: 'read', description: '列出报表中心可用的报表目录及刷新口径' },
  { name: 'export', kind: 'action', description: '导出指定报表为 xlsx、csv 或 pdf 格式' }
];

/** report.center 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const reportCenterManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'report-center-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'report.center',
  version: '1.0.0',
  description: '报表中心插件，提供报表目录查看与受控导出的确定性模拟',
  capabilities: ['report.read', 'report.export'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/report-center.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['report.read', 'report.export'] },
  dependencies: []
};

/**
 * 从 params 或 query 关键词推断目标报表，默认销售日报。
 *
 * @param query - 用户查询文本
 * @param params - 已解析参数
 * @returns 目标报表 fixture 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function resolveReport(query: string, params: Record<string, string>): Record<string, JsonValue> | undefined {
  if (params.reportId) return REPORTS.find((report) => report.reportId === params.reportId);
  if (/周报|经营/.test(query)) return REPORTS[1];
  if (/用户|增长/.test(query)) return REPORTS[2];
  if (/资源|消耗|CU/.test(query)) return REPORTS[3];
  return REPORTS[0];
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
 * 处理报表知识检索、目录查询与导出受理，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const reportCenterHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('report.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : 'list');
  const op = findSandboxOperation(reportCenterOperations, operation);
  if (!op) return fail('report.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('report.query_required');
    const results = retrieveKnowledge('report.center', parsed.query, 3);
    return succeed('search', { results, summary: `报表中心知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'list') {
    return succeed('list', { reports: [...REPORTS], summary: `报表中心共 ${String(REPORTS.length)} 张报表，数据默认 T+1 刷新` });
  }
  const report = resolveReport(parsed.query, parsed.params);
  if (!report) return fail('report.not_found');
  const format = parsed.params.format ?? 'xlsx';
  const reportId = String(report.reportId ?? 'unknown');
  const name = String(report.name ?? '未知报表');
  return succeed('export', {
    receipt: `export-${reportId}`,
    reportId,
    format,
    summary: `已受理导出「${name}」（${format}），生成完成后可在下载中心获取`
  });
};

/** 可直接交给 PluginHost.install 的 report.center 注册对象。 */
export const reportCenterPlugin: PluginRegistration = { manifest: reportCenterManifest, handler: reportCenterHandler };
