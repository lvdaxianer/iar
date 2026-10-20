/**
 * 提供任务调度监控（job.monitor）Function 插件。
 *
 * 模拟企业数据平台的调度监控子系统：search 从本地调度知识库做确定性
 * 检索返回 top3（带 score 与 answer），status/logs 返回本地确定性任务
 * fixture（状态、耗时、最近日志），不产生真实副作用；
 * operation 缺省时知识型问法默认 search，其余默认执行 status。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { FunctionPluginManifest, JsonValue } from '@iar/contracts';
import type { PluginHandler, PluginRegistration } from '@iar/plugin-sdk';
import { retrieveKnowledge } from '../knowledge/retrieval.js';
import { fail, findSandboxOperation, parseSandboxInput, sandboxInputSchema, sandboxOutputSchema, succeed, type SandboxOperation } from './common.js';

/** job.monitor 的确定性调度任务 fixture。 */
const JOBS: ReadonlyArray<Record<string, JsonValue>> = [
  {
    jobName: '订单汇总日报',
    scheduler: 'DolphinScheduler',
    status: 'success',
    startedAt: '2026-10-18 01:00:00',
    finishedAt: '2026-10-18 01:24:36',
    duration: '24 分钟',
    result: '产出 dws_order_summary/dt=2026-10-17'
  },
  {
    jobName: '用户标签刷新',
    scheduler: 'DolphinScheduler',
    status: 'failed',
    startedAt: '2026-10-18 02:00:00',
    finishedAt: '2026-10-18 02:03:12',
    duration: '3 分钟',
    result: 'Spark 阶段失败：Executor OOM（container exited 137）'
  },
  {
    jobName: '实时风控校验',
    scheduler: 'Flink',
    status: 'running',
    startedAt: '2026-10-18 05:30:00',
    finishedAt: null,
    duration: '已运行 58 分钟',
    result: '消费 Kafka 风控事件 topic，当前无延迟'
  }
];

/** job.monitor 的确定性日志行 fixture。 */
const JOB_LOGS: Readonly<Record<string, readonly string[]>> = {
  订单汇总日报: [
    '01:00:00 INFO 实例 job-20261018-001 触发，依赖检查通过',
    '01:02:11 INFO 上游 dwd_order 分区就绪，开始汇总计算',
    '01:20:45 INFO 写出 dws_order_summary/dt=2026-10-17 完成',
    '01:24:36 INFO 实例成功结束，耗时 24 分钟'
  ],
  用户标签刷新: [
    '02:00:00 INFO 实例 job-20261018-002 触发',
    '02:01:30 WARN 阶段 3/7 出现数据倾斜，key=city_id',
    '02:03:12 ERROR Executor OOM：container exited 137',
    '02:03:12 ERROR 实例失败，已按策略重试 1/3'
  ],
  实时风控校验: [
    '05:30:00 INFO Flink 作业启动，并行度 32',
    '05:31:02 INFO Kafka 消费位点重置到最新',
    '06:10:44 INFO checkpoint 完成，耗时 3.2s',
    '06:28:01 INFO 处理速率 1.8 万条/秒，无积压'
  ]
};

/** job.monitor 的显式操作目录。 */
export const jobMonitorOperations: readonly SandboxOperation[] = [
  { name: 'search', kind: 'read', description: '检索调度监控知识库，返回相关度最高的 3 条说明' },
  { name: 'status', kind: 'read', description: '查看调度任务的运行状态、起止时间与最近结果' },
  { name: 'logs', kind: 'read', description: '查看调度任务最近一次的运行日志' }
];

/** job.monitor 的版本化 Function Manifest，policy 声明 high 作为安全上限。 */
export const jobMonitorManifest: FunctionPluginManifest = {
  apiVersion: 'iar.dev/v1',
  schemaVersion: 'iar.plugin-manifest/v1',
  pluginId: 'job-monitor-v1',
  pluginKind: 'function',
  scope: 'function',
  functionId: 'job.monitor',
  version: '1.0.0',
  description: '任务调度监控插件，提供调度任务状态与运行日志的确定性模拟',
  actionTypes: ['query'],
  operations: jobMonitorOperations,
  capabilities: ['job.read'],
  inputSchema: sandboxInputSchema(),
  outputSchema: sandboxOutputSchema(),
  lifecycle: { entrypoint: './dist/examples/agent-sandbox/src/functions/job-monitor.js' },
  policy: { riskLevel: 'high', requiresConfirmation: true, allowedCapabilities: ['job.read'] },
  dependencies: []
};

/**
 * 按 params 与 query 关键词匹配目标任务，未命中时返回 undefined。
 *
 * 匹配时先剥离任务名末尾的常见业务后缀（日报/校验等），
 * 使「订单汇总」也能命中「订单汇总日报」。
 *
 * @param query - 用户查询文本
 * @param params - 已解析参数
 * @returns 目标任务 fixture 或 undefined
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
function resolveJob(query: string, params: Record<string, string>): Record<string, JsonValue> | undefined {
  const name = params.jobName;
  if (name) return JOBS.find((job) => job.jobName === name);
  return JOBS.find((job) => {
    const jobName = String(job.jobName);
    const stem = jobName.replace(/(日报|周报|月报|年报|校验|刷新|同步)$/u, '');
    return query.includes(jobName) || (stem.length >= 2 && query.includes(stem));
  });
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
 * 处理调度任务检索、状态与日志查询，全部返回确定性结果。
 *
 * @param input - 统一 Handler 输入
 * @returns 操作结果或稳定错误码
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
export const jobMonitorHandler: PluginHandler = async (input) => {
  const parsed = parseSandboxInput(input);
  if (!parsed) return fail('job.invalid_input');
  const operation = parsed.operation ?? (isKnowledgeQuery(parsed.query) ? 'search' : 'status');
  const op = findSandboxOperation(jobMonitorOperations, operation);
  if (!op) return fail('job.unknown_operation');
  if (operation === 'search') {
    if (parsed.query.trim().length === 0) return fail('job.query_required');
    const results = retrieveKnowledge('job.monitor', parsed.query, 3);
    return succeed('search', { results, summary: `调度监控知识库检索完成，命中 ${String(results.length)} 条` });
  }
  const job = resolveJob(parsed.query, parsed.params);
  if (!job) {
    // 未定位到具体任务时返回全部任务状态总览，方便用户继续追问。
    return succeed('status', { jobs: [...JOBS], summary: `未匹配到具体任务，返回 ${String(JOBS.length)} 个在管任务的状态总览` });
  }
  const jobName = String(job.jobName ?? '未知任务');
  if (operation === 'logs') {
    const logs = JOB_LOGS[jobName] ?? [];
    return succeed('logs', { jobName, logs: [...logs], summary: `任务「${jobName}」最近一次实例日志 ${String(logs.length)} 行` });
  }
  return succeed('status', { job, summary: `任务「${jobName}」状态 ${String(job.status ?? 'unknown')}：${String(job.result ?? '无结果信息')}` }, { jobName, status: job.status ?? 'unknown' });
};

/** 可直接交给 PluginHost.install 的 job.monitor 注册对象。 */
export const jobMonitorPlugin: PluginRegistration = { manifest: jobMonitorManifest, handler: jobMonitorHandler };
