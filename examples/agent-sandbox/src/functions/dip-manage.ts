/**
 * 提供数据集成管理（dip.manage）Function 插件。
 *
 * 模拟企业数据平台的 DIP 子系统：search 从本地集成知识库做确定性检索
 * 返回 top3（带 score 与 answer），list/detail 返回本地确定性任务 fixture，
 * rerun/stop 模拟受理并返回受理号，不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余按 query 关键词在 read 操作（detail/list）内推断。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import { SCHEMA_VERSIONS, type BusinessPluginManifest, type FunctionDefinition, type JsonValue } from '@iar/contracts';
import type { FunctionHandler, PluginPackage } from '@iar/plugin';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { defineSandboxPlugin, fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** dip.manage 的确定性集成任务 fixture。 */
const DIP_TASKS: ReadonlyArray<Record<string, JsonValue>> = [
  {
    taskId: 'dip-task-order-sync',
    name: '订单同步',
    source: '业务库 orders（binlog）',
    target: '数仓 dwd_order',
    schedule: '每 10 分钟',
    status: 'failed',
    lastRunAt: '2026-10-18 02:10:00',
    lastError: '目标表分区不存在：dwd_order/dt=2026-10-17',
    owner: '数据平台组'
  },
  {
    taskId: 'dip-task-user-sync',
    name: '用户主数据同步',
    source: 'CRM 主数据',
    target: '数仓 dim_user',
    schedule: '每小时',
    status: 'success',
    lastRunAt: '2026-10-18 05:00:00',
    owner: '数据平台组'
  },
  {
    taskId: 'dip-task-event-collect',
    name: '埋点日志采集',
    source: 'Kafka topic app-events',
    target: '数据湖 ods_event',
    schedule: '实时',
    status: 'running',
    lastRunAt: '2026-10-18 06:30:12',
    owner: '增长数据组'
  },
  {
    taskId: 'dip-task-goods-sync',
    name: '商品库同步',
    source: '商品中心',
    target: '数仓 dim_sku',
    schedule: '每日 02:00',
    status: 'paused',
    lastRunAt: '2026-10-17 02:00:00',
    owner: '电商数据组'
  }
];

/** dip.manage 的显式操作目录。 */
export const dipManageOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索 DIP 集成知识库，返回相关度最高的 3 条说明' },
  { name: 'list', kind: 'read', description: '列出全部 DIP 集成任务及最近运行状态' },
  { name: 'detail', kind: 'read', description: '查看单个集成任务的配置、来源目标与最近错误' },
  { name: 'rerun', kind: 'action', description: '重新运行指定（或默认）集成任务，生成新实例' },
  { name: 'stop', kind: 'action', description: '停止指定集成任务并中断当前运行实例' }
];

/** dip.manage 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const dipManageManifest: BusinessPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'dip-manage-v1',
  pluginKind: 'business',
  scope: 'plugin',
  version: '1.0.0',
  description: '数据集成管理插件，提供 DIP 任务列表、详情、重跑与停止的确定性模拟',
  capabilities: ['dip.read', 'dip.control'],
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/dip-manage.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['dip.read', 'dip.control'] },
  dependencies: []
};

export const dipManageFunction: FunctionDefinition = {
  schemaVersion: SCHEMA_VERSIONS.function,
  functionId: 'dip.manage',
  version: dipManageManifest.version,
  name: '数据集成管理',
  description: dipManageManifest.description,
  actionTypes: ['query', 'execute'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  capabilities: [...dipManageManifest.capabilities],
  riskLevel: dipManageManifest.policy.riskLevel
};

/**
 * 从 params 或 query 关键词推断目标任务，默认订单同步任务。
 *
 * @param query - 用户查询文本
 * @param params - 已解析参数
 * @returns 目标任务 fixture 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function resolveTask(query: string, params: Record<string, string>): Record<string, JsonValue> | undefined {
  const taskId = params.taskId;
  if (taskId) return DIP_TASKS.find((task) => task.taskId === taskId);
  if (/用户/.test(query)) return DIP_TASKS[1];
  if (/埋点|日志|事件/.test(query)) return DIP_TASKS[2];
  if (/商品/.test(query)) return DIP_TASKS[3];
  return DIP_TASKS[0];
}

/**
 * operation 缺省时按 query 关键词推断默认 read 操作。
 *
 * @param query - 用户查询文本
 * @returns 推断出的 read 操作名
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function inferReadOperation(query: string): string {
  return /详情|明细|配置/.test(query) ? 'detail' : 'list';
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
 * 处理 DIP 任务检索与受控操作，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const dipManageHandler: FunctionHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('dip.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : inferReadOperation(parsed.query));
  const op = findSandboxOperation(dipManageOperations, operation);
  if (!op) return fail('dip.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('dip.query_required');
    const results = retrieveKnowledge('dip.manage', parsed.query, 3);
    return succeed('search', { results, summary: `DIP 集成知识库检索完成，命中 ${String(results.length)} 条` });
  }
  if (operation === 'list') {
    const failed = DIP_TASKS.filter((task) => task.status === 'failed').length;
    return succeed('list', { tasks: [...DIP_TASKS], summary: `共 ${String(DIP_TASKS.length)} 个集成任务，${String(failed)} 个失败，1 个运行中` });
  }
  const task = resolveTask(parsed.query, parsed.params);
  if (!task) return fail('dip.task_not_found');
  const name = String(task.name ?? '未知任务');
  const taskId = String(task.taskId ?? 'unknown');
  if (operation === 'detail') {
    return succeed('detail', { task, summary: `任务「${name}」当前状态 ${String(task.status ?? 'unknown')}，调度周期 ${String(task.schedule ?? '未知')}` }, { status: task.status ?? 'unknown' });
  }
  if (operation === 'rerun') {
    return succeed('rerun', { receipt: `dip-rerun-${taskId}`, taskId, status: 'rerunning', summary: `已受理重跑任务「${name}」，新实例排队中` }, { receipt: `dip-rerun-${taskId}`, taskId, status: 'rerunning' });
  }
  return succeed('stop', { receipt: `dip-stop-${taskId}`, taskId, status: 'stopping', summary: `已受理停止任务「${name}」，当前实例将被中断` }, { receipt: `dip-stop-${taskId}`, taskId, status: 'stopping' });
};

/** 可直接交给 PluginHost.install 的 dip.manage 注册对象。 */
export const dipManagePlugin: PluginPackage = defineSandboxPlugin(dipManageManifest, dipManageFunction, dipManageOperations, dipManageHandler);
