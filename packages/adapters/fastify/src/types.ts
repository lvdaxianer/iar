/**
 * 定义 Fastify adapter 的注入依赖、响应 envelope 和公开摘要类型。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import type { FastifyInstance } from 'fastify';
import type { PluginHost, PluginRecord } from '@iar/plugins';
import type { LocalWorkflow, WorkflowRun } from '@iar/workflow';

/**
 * Fastify adapter 响应使用的稳定版本。
 * 版本字段是客户端兼容性协商的唯一公开入口。
 */
export const FASTIFY_RESPONSE_VERSION = 'iar.fastify-response/v1' as const;

/**
 * Fastify adapter 内部的 API 版本。
 * 它与公共 schemaVersion 同时返回，便于区分协议和实现版本。
 */
export const FASTIFY_API_VERSION = 'fastify.v1' as const;

/**
 * 公开错误不携带内部异常正文或原始请求。
 * code/retryable 足够驱动客户端状态机。
 */
export type FastifyApiError = {
  code: string;
  message: string;
  retryable: boolean;
};

/**
 * 所有 API 成功和失败路径共用的响应 envelope。
 * data 与 error 互斥，但两个字段始终存在。
 */
export type FastifyApiResponse<T> = {
  schemaVersion: typeof FASTIFY_RESPONSE_VERSION;
  traceId: string;
  runId: string;
  version: typeof FASTIFY_API_VERSION;
  data: T | null;
  error: FastifyApiError | null;
};

/**
 * Fastify adapter 创建时注入的确定性核心服务。
 * adapter 不创建第二套 Workflow 或 PluginHost。
 */
export type FastifyHostOptions = {
  workflow: LocalWorkflow;
  pluginHost: PluginHost;
  traceIdFactory?: () => string;
};

/** 对外暴露的 Workflow 运行摘要，不包含 definition 和 Action input。 */
export type PublicWorkflowRun = Pick<WorkflowRun, 'runId' | 'workflowId' | 'currentStep' | 'status' | 'attempts' | 'actionStatus' | 'lastError' | 'confirmation'>;

/** 对外暴露的 Plugin 生命周期摘要，不包含 schema、lifecycle 和敏感配置。 */
export type PublicPlugin = {
  pluginId: string;
  functionIds?: string[];
  version: string;
  state: PluginRecord['state'];
};

/** 供调用方保留 Fastify 实例类型的工厂返回类型。 */
export type FastifyHostApp = FastifyInstance;
