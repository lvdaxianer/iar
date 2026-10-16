/**
 * 将本地 Workflow 和 PluginHost 暴露为受限的 Fastify API。
 *
 * HTTP 层只做参数边界、统一 envelope 和公开字段投影；业务状态仍由
 * LocalWorkflow/PluginHost 管理，避免 Fastify 成为第二套运行时语义。
 *
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import type { PluginManifest } from '@iar/contracts';
import { type FastifyHostApp, type FastifyHostOptions } from './types.js';
import { type AdapterContext, type RequestWithParams, failure, hostError, invalidRequest, isJsonValue, pluginStatus, publicPlugin, publicRun, readField, readString, recordBody, registerHttpBoundaries, requestTraceId, send, success, workflowError, workflowStatus } from './http-boundary.js';

type PluginStateOptions = { context: AdapterContext; request: RequestWithParams; reply: FastifyReply; target: 'enable' | 'disable' };

/**
 * 创建带有 IAR 版本化路由的 Fastify 实例。
 *
 * @param options - 注入的 Workflow、PluginHost 和 traceId 工厂
 * @returns 尚未监听端口的 Fastify 实例，可用 inject 或 listen 调用
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
export async function createFastifyApp(options: FastifyHostOptions): Promise<FastifyHostApp> {
  const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }) });
  let generatedTraceSequence = 0;
  const nextTraceId = (): string => options.traceIdFactory?.() ?? `trace-generated-${++generatedTraceSequence}`;
  const context: AdapterContext = { options, nextTraceId, traceIds: new WeakMap(), requestStartedAt: new WeakMap() };
  registerHttpBoundaries(app, context);
  registerRunRoutes(app, context);
  registerPluginRoutes(app, context);
  return app;
}

/**
 * 注册 run 创建、follow-up、查询和 confirmation 路由。
 *
 * @param app - Fastify 应用实例
 * @param context - 注入的核心服务和 traceId 生成器
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registerRunRoutes(app: FastifyHostApp, context: AdapterContext): void {
  app.post('/v1/runs', (request, reply) => createRun(context, request, reply));
  app.post('/v1/runs/:runId/input', (request: RequestWithParams, reply) => submitInput(context, request, reply));
  app.get('/v1/runs/:runId', (request: RequestWithParams, reply) => getRun(context, request, reply));
  app.post('/v1/runs/:runId/confirm', (request: RequestWithParams, reply) => confirmRun(context, request, reply));
}

/**
 * 注册 plugin install/enable/disable 路由。
 *
 * @param app - Fastify 应用实例
 * @param context - 注入的 PluginHost 和 traceId 生成器
 * @returns 不返回值
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
function registerPluginRoutes(app: FastifyHostApp, context: AdapterContext): void {
  app.post('/v1/plugins/install', (request, reply) => installPlugin(context, request, reply));
  app.post('/v1/plugins/:pluginId/enable', (request: RequestWithParams, reply) => changePluginState({ context, request, reply, target: 'enable' }));
  app.post('/v1/plugins/:pluginId/disable', (request: RequestWithParams, reply) => changePluginState({ context, request, reply, target: 'disable' }));
}

/**
 * 创建 run，并把 workflow 状态投影为安全的公开摘要。
 * raw input 只经过边界验证，不作为 adapter 状态保存。
 * workflow 的稳定 reasonCode 会转换成统一 HTTP error。
 * @param context - 注入的 Workflow 和 traceId 工厂
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function createRun(context: AdapterContext, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const runId = readString(body, 'runId') ?? '';
  const definition = readField(body, 'definition');
  // 运行定义和 id 必须在调用 LocalWorkflow 前通过最小输入边界。
  if (!runId || !definition || !isJsonValue(definition)) return send(reply, 400, failure(traceId, runId, invalidRequest('run 创建请求无效')));
  const result = context.options.workflow.start({ runId, definition: definition as never });
  // Workflow 拒绝非法定义或重复 runId 时映射为稳定业务错误。
  if (!result.ok) return send(reply, workflowStatus(result.reasonCode), failure(traceId, runId, workflowError(result.reasonCode)));
  return send(reply, 201, success(traceId, runId, publicRun(result.value)));
}

/**
 * 提交 follow-up input，只验证 JSON 边界而不保存 raw input。
 * 当前任务不改变 LocalWorkflow 的编排语义，只确认宿主接收成功。
 * 非 JSON 值和不存在的 run 都在进入业务层前拒绝。
 * @param context - 注入的 Workflow 和 traceId 工厂
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function submitInput(context: AdapterContext, request: RequestWithParams, reply: FastifyReply): Promise<unknown> {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const runId = readString(request.params, 'runId') ?? '';
  const input = readField(body, 'input');
  const current = context.options.workflow.get(runId);
  // 不存在的 run 不能接收或伪造 follow-up input。
  if (!current.ok) return send(reply, 404, failure(traceId, runId, workflowError(current.reasonCode)));
  // follow-up input 只允许 JSON 值，adapter 不保存 raw prompt 或 raw user input。
  if (input === undefined || !isJsonValue(input)) return send(reply, 400, failure(traceId, runId, invalidRequest('follow-up input 无效')));
  return send(reply, 202, success(traceId, runId, { accepted: true }));
}

/**
 * 查询状态，只返回可恢复的公共摘要。
 * definition、Action input 和完整敏感上下文永远不进入公开 data。
 * @param context - 注入的 Workflow 和 traceId 工厂
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function getRun(context: AdapterContext, request: RequestWithParams, reply: FastifyReply): Promise<unknown> {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const runId = readString(request.params, 'runId') ?? '';
  const result = context.options.workflow.get(runId);
  // 不存在的 run 只返回资源错误，不创建隐式状态。
  if (!result.ok) return send(reply, 404, failure(traceId, runId, workflowError(result.reasonCode)));
  return send(reply, 200, success(traceId, runId, publicRun(result.value)));
}

/**
 * 提交完整 Action confirmation，scope 校验仍由 LocalWorkflow 负责。
 * adapter 不自行重算 scope，避免 HTTP 层出现第二套确认语义。
 * response 只投影确认状态，不回显 Action input。
 * @param context - 注入的 Workflow 和 traceId 工厂
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function confirmRun(context: AdapterContext, request: RequestWithParams, reply: FastifyReply): Promise<unknown> {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const runId = readString(request.params, 'runId') ?? '';
  const action = readField(body, 'action');
  const scopeHash = readString(body, 'scopeHash');
  const confirmedAt = readString(body, 'confirmedAt');
  // confirmation 字段必须完整且 Action 必须是 JSON 值，才能交给 Workflow 校验。
  if (!action || !scopeHash || !confirmedAt || !isJsonValue(action)) return send(reply, 400, failure(traceId, runId, invalidRequest('confirmation 请求无效')));
  const result = context.options.workflow.confirm({ runId, action: action as never, scopeHash, confirmedAt });
  // Workflow 负责 scope、run、终态和 Policy 语义，adapter 只映射结果。
  if (!result.ok || !result.value) return send(reply, workflowStatus(result.reasonCode), failure(traceId, runId, workflowError(result.reasonCode)));
  return send(reply, 200, success(traceId, runId, publicRun(result.value)));
}

/**
 * 安装插件并只返回生命周期摘要。
 * 完整 Manifest 交给 PluginHost 做契约校验和原子安装。
 * @param context - 注入的 PluginHost 和 traceId 工厂
 * @param request - 当前 HTTP 请求
 * @param reply - Fastify 回复对象
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function installPlugin(context: AdapterContext, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const body = recordBody(request.body);
  const traceId = requestTraceId({ request, body, nextTraceId: context.nextTraceId, traceIds: context.traceIds });
  const manifest = readField(body, 'manifest');
  // 非 JSON 或空 manifest 不能进入 PluginHost。
  if (!manifest || !isJsonValue(manifest)) return send(reply, 400, failure(traceId, '', invalidRequest('plugin manifest 无效')));
  const result = context.options.pluginHost.install(manifest as PluginManifest);
  // PluginHost 负责 schema、归属和原子安装，adapter 不改写错误语义。
  if (!result.ok) return send(reply, pluginStatus(result.error.code), failure(traceId, '', hostError(result.error.code)));
  return send(reply, 201, success(traceId, '', { plugin: publicPlugin(result.value) }));
}

/**
 * 统一处理 enable/disable 的 PluginHost 生命周期结果。
 * target 只允许两个显式分支，不能由请求体动态扩展操作集合。
 * @param options - PluginHost 生命周期调用参数
 * @returns 统一 HTTP 响应
 * @author lvdaxianer@yeah.net
 * @date 2026-10-17
 */
async function changePluginState(options: PluginStateOptions): Promise<unknown> {
  const pluginId = readString(options.request.params, 'pluginId') ?? '';
  // target 由固定路由传入，未知值无法扩展 PluginHost 操作集合。
  const result = options.target === 'enable' ? options.context.options.pluginHost.enable(pluginId) : options.context.options.pluginHost.disable(pluginId);
  const body = recordBody(options.request.body);
  const traceId = requestTraceId({ request: options.request, body, nextTraceId: options.context.nextTraceId, traceIds: options.context.traceIds });
  // PluginHost 拒绝非法生命周期或未知插件时保持稳定错误。
  if (!result.ok) return send(options.reply, pluginStatus(result.error.code), failure(traceId, '', hostError(result.error.code)));
  return send(options.reply, 200, success(traceId, '', { plugin: publicPlugin(result.value) }));
}
