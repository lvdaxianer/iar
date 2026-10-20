/**
 * 提供 agent sandbox 十个 Function 插件的汇总注册与能力清单元数据。
 *
 * allSandboxPlugins 可直接交给 PluginHost 安装；sandboxFunctionCatalog
 * 以 functionId 为键描述每个子系统的中文名、插件标识、显式操作目录与
 * 默认操作，供 session 判定确认策略、兜底回复与提示词描述能力使用；
 * sandboxFunctionIds 保持稳定的十子系统顺序。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-18
 */
import type { PluginPackage } from '@iar/plugin';
import { accountPrivilegeOperations, accountPrivilegePlugin } from './account-privilege.js';
import { apiGatewayOperations, apiGatewayPlugin } from './api-gateway.js';
import type { SandboxOperation } from './common.js';
import { datasetQueryOperations, datasetQueryPlugin } from './dataset-query.js';
import { dipManageOperations, dipManagePlugin } from './dip-manage.js';
import { humanTransferOperations, humanTransferPlugin } from './human-transfer.js';
import { jobMonitorOperations, jobMonitorPlugin } from './job-monitor.js';
import { knowledgeQueryOperations, knowledgeQueryPlugin } from './knowledge-query.js';
import { reportCenterOperations, reportCenterPlugin } from './report-center.js';
import { systemStatusOperations, systemStatusPlugin } from './system-status.js';
import { ticketCreateOperations, ticketCreatePlugin } from './ticket-create.js';

/** 单个子系统的能力描述元数据。 */
export type SandboxFunctionDescriptor = {
  /** Function 标识，与 semantic.extract 的 intent 一一对应。 */
  functionId: string;
  /** 子系统中文名。 */
  name: string;
  /** 归属插件标识。 */
  pluginId: string;
  /** 子系统能力概述。 */
  description: string;
  /** 显式操作目录。 */
  operations: readonly SandboxOperation[];
  /** operation 缺省时使用的默认操作名。 */
  defaultOperation: string;
};

/** sandbox 模拟的企业数据平台十个子系统的能力清单。 */
export const sandboxFunctionCatalog: Readonly<Record<string, SandboxFunctionDescriptor>> = {
  'knowledge.query': {
    functionId: 'knowledge.query',
    name: '平台通用知识',
    pluginId: 'knowledge-query-v1',
    description: '平台使用 FAQ 与通用知识检索',
    operations: knowledgeQueryOperations,
    defaultOperation: 'search'
  },
  'dip.manage': {
    functionId: 'dip.manage',
    name: '数据集成管理',
    pluginId: 'dip-manage-v1',
    description: 'DIP 集成任务列表、详情、重跑与停止',
    operations: dipManageOperations,
    defaultOperation: 'list'
  },
  'job.monitor': {
    functionId: 'job.monitor',
    name: '任务调度监控',
    pluginId: 'job-monitor-v1',
    description: '调度任务运行状态与日志查询',
    operations: jobMonitorOperations,
    defaultOperation: 'status'
  },
  'api.gateway': {
    functionId: 'api.gateway',
    name: 'API 网关管理',
    pluginId: 'api-gateway-v1',
    description: '网关调用统计查看与限流配额调整',
    operations: apiGatewayOperations,
    defaultOperation: 'stats'
  },
  'dataset.query': {
    functionId: 'dataset.query',
    name: '数据资产目录',
    pluginId: 'dataset-query-v1',
    description: '数据表、指标检索与血缘查询',
    operations: datasetQueryOperations,
    defaultOperation: 'search'
  },
  'report.center': {
    functionId: 'report.center',
    name: '报表中心',
    pluginId: 'report-center-v1',
    description: '报表目录查看与受控导出',
    operations: reportCenterOperations,
    defaultOperation: 'list'
  },
  'system.status': {
    functionId: 'system.status',
    name: '系统状态与告警',
    pluginId: 'system-status-v1',
    description: '服务健康度总览与活动告警',
    operations: systemStatusOperations,
    defaultOperation: 'overview'
  },
  'account.privilege': {
    functionId: 'account.privilege',
    name: '账户与权限',
    pluginId: 'account-privilege-v1',
    description: '本人权限查询与授权申请',
    operations: accountPrivilegeOperations,
    defaultOperation: 'mine'
  },
  'ticket.create': {
    functionId: 'ticket.create',
    name: '工单支持',
    pluginId: 'ticket-create-v1',
    description: '工单进度查询与工单创建',
    operations: ticketCreateOperations,
    defaultOperation: 'create'
  },
  'human.transfer': {
    functionId: 'human.transfer',
    name: '人工服务',
    pluginId: 'human-transfer-v1',
    description: '转接人工客服队列',
    operations: humanTransferOperations,
    defaultOperation: 'transfer'
  }
};

/** 十个子系统的稳定顺序列表。 */
export const sandboxFunctionIds: readonly string[] = [
  'knowledge.query',
  'dip.manage',
  'job.monitor',
  'api.gateway',
  'dataset.query',
  'report.center',
  'system.status',
  'account.privilege',
  'ticket.create',
  'human.transfer'
];

/** 交给 PluginHost 顺序安装的十个插件注册对象。 */
export const allSandboxPlugins: readonly PluginPackage[] = [
  knowledgeQueryPlugin,
  dipManagePlugin,
  jobMonitorPlugin,
  apiGatewayPlugin,
  datasetQueryPlugin,
  reportCenterPlugin,
  systemStatusPlugin,
  accountPrivilegePlugin,
  ticketCreatePlugin,
  humanTransferPlugin
];
