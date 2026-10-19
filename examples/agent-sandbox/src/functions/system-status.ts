/**
 * 提供系统状态与告警（system.status）Function 插件。
 *
 * 模拟企业数据平台的状态子系统：search 从本地状态知识库做确定性检索
 * 返回 top3（带 score 与 answer），overview 返回本地确定性服务健康度 fixture，
 * alerts 返回当前活动告警列表，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余按 query 关键词推断。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** system.status 的确定性服务健康度 fixture。 */
const SERVICES: ReadonlyArray<Record<string, JsonValue>> = [
  { service: 'api-gateway', status: 'green', version: 'v2.14.3', uptime: '32 天', note: '核心指标正常' },
  { service: 'dip-server', status: 'yellow', version: 'v1.9.0', uptime: '12 天', note: '订单同步任务失败率升高，处理中' },
  { service: 'scheduler', status: 'green', version: 'v3.2.1', uptime: '58 天', note: '核心指标正常' },
  { service: 'report-engine', status: 'red', version: 'v1.4.8', uptime: '0 天', note: '报表引擎实例重启中，预计 10 分钟恢复' }
];

/** system.status 的确定性活动告警 fixture。 */
const ALERTS: ReadonlyArray<Record<string, JsonValue>> = [
  { alertId: 'alert-1001', level: 'P2', service: 'dip-server', message: '订单同步任务连续 3 次失败', startedAt: '2026-10-18 02:10:00', status: 'processing' },
  { alertId: 'alert-1002', level: 'P1', service: 'report-engine', message: '报表导出队列积压超过 5000 单', startedAt: '2026-10-18 06:40:00', status: 'acknowledged' },
  { alertId: 'alert-1003', level: 'P3', service: 'api-gateway', message: 'open-platform 应用 429 比例超过阈值', startedAt: '2026-10-18 06:15:00', status: 'open' }
];

/** system.status 的显式操作目录。 */
export const systemStatusOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索系统状态知识库，返回相关度最高的 3 条说明' },
  { name: 'overview', kind: 'read', description: '查看各核心服务的健康度、版本与运行说明' },
  { name: 'alerts', kind: 'read', description: '查看当前活动告警的等级、来源与处理状态' }
];

/** system.status 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const systemStatusManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'system-status-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'system.status',
  version: '1.0.0',
  description: '系统状态与告警插件，提供服务健康度总览与活动告警列表的确定性模拟',
  actionTypes: ['query'],
  capabilities: ['status.read'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/system-status.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['status.read'] },
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
  return /告警|报警/.test(query) ? 'alerts' : 'overview';
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
 * 处理系统知识检索、服务健康度与告警查询，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const systemStatusHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('status.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : inferOperation(parsed.query));
  const op = findSandboxOperation(systemStatusOperations, operation);
  if (!op) return fail('status.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('status.query_required');
    const results = retrieveKnowledge('system.status', parsed.query, 3);
    return succeed('search', { results, summary: `系统状态知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'alerts') {
    const open = ALERTS.filter((alert) => alert.status !== 'closed').length;
    return succeed('alerts', { alerts: [...ALERTS], summary: `当前 ${String(open)} 条活动告警，其中 P1 一条，请关注报表引擎积压` });
  }
  const red = SERVICES.filter((service) => service.status === 'red').length;
  const yellow = SERVICES.filter((service) => service.status === 'yellow').length;
  return succeed('overview', { services: [...SERVICES], summary: `${String(SERVICES.length)} 个核心服务：${String(red)} 个异常、${String(yellow)} 个降级、其余正常` });
};

/** 可直接交给 PluginHost.install 的 system.status 注册对象。 */
export const systemStatusPlugin: PluginRegistration = { manifest: systemStatusManifest, handler: systemStatusHandler };
